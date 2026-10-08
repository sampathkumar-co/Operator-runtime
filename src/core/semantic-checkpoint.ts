import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import type { DeviceIdentityStore } from './device-identity.ts';
import type { DeviceRegistryStore } from './device-registry.ts';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { withDurableStateLock } from './durable-state-lock.ts';

export type MigratableWorkloadKind = 'task' | 'mission' | 'operation';

export interface SemanticCheckpointArtifact {
  key: string;
  digest: string;
  size?: number;
}

export interface SemanticWorldAssumption {
  entityKey: string;
  factKey: string;
  valueDigest: string;
}

export interface SemanticCheckpoint {
  version: 1;
  checkpointId: string;
  workloadKind: MigratableWorkloadKind;
  workloadId: string;
  sourceDeviceId: string;
  createdAt: string;
  expiresAt: string;
  objectiveDigest: string;
  stateDigest: string;
  authorityDigest: string;
  requiredCapabilities: string[];
  resourceKeys: string[];
  artifactDigests: SemanticCheckpointArtifact[];
  worldAssumptions: SemanticWorldAssumption[];
  completedStepDigests: string[];
  verificationDigest?: string;
  continuation: Record<string, unknown>;
}

export interface SignedSemanticCheckpoint {
  checkpoint: SemanticCheckpoint;
  signature: string;
}

interface MigrationState {
  version: 1;
  accepted: Array<{
    checkpointId: string;
    workloadId: string;
    sourceDeviceId: string;
    acceptedAt: string;
    stateDigest: string;
    authorityDigest: string;
    checkpointDigest: string;
  }>;
}

const SECRET_KEY = /(pass(word)?|secret|token|authorization|cookie|credential|private.?key|api.?key|recovery)/i;
const MAX_CONTINUATION_BYTES = 512 * 1024;
const MAX_ITEMS = 5000;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;
const STORE_OPTIONS = {
  maxBytes: 4 * 1024 * 1024,
  errorCode: 'SEMANTIC_MIGRATION_CORRUPT',
  invalidMessage: 'Semantic migration state is invalid.'
} as const;

export class SemanticCheckpointManager {
  #identity: DeviceIdentityStore;
  #registry: DeviceRegistryStore;
  #file: string;
  #clock: () => Date;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: {
    identity: DeviceIdentityStore;
    registry: DeviceRegistryStore;
    clock?: () => Date;
  }) {
    this.#identity = options.identity;
    this.#registry = options.registry;
    this.#file = path.join(path.resolve(stateDir), 'semantic-migrations.json');
    this.#clock = options.clock ?? (() => new Date());
  }

  async create(input: {
    workloadKind: MigratableWorkloadKind;
    workloadId: string;
    objectiveDigest: string;
    stateDigest: string;
    authorityDigest: string;
    requiredCapabilities?: string[];
    resourceKeys?: string[];
    artifactDigests?: SemanticCheckpointArtifact[];
    worldAssumptions?: SemanticWorldAssumption[];
    completedStepDigests?: string[];
    verificationDigest?: string;
    continuation: Record<string, unknown>;
    ttlMs?: number;
  }): Promise<SignedSemanticCheckpoint> {
    const identity = await this.#identity.loadOrCreate();
    const now = this.#clock();
    const ttlMs = boundedInteger(input.ttlMs ?? 30 * 60_000, MIN_TTL_MS, MAX_TTL_MS, 'ttlMs');
    const checkpoint: SemanticCheckpoint = {
      version: 1,
      checkpointId: crypto.randomUUID(),
      workloadKind: workloadKind(input.workloadKind),
      workloadId: uuid(input.workloadId, 'workloadId'),
      sourceDeviceId: uuid(identity.deviceId, 'sourceDeviceId'),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      objectiveDigest: digest(input.objectiveDigest, 'objectiveDigest'),
      stateDigest: digest(input.stateDigest, 'stateDigest'),
      authorityDigest: digest(input.authorityDigest, 'authorityDigest'),
      requiredCapabilities: uniqueStrings(input.requiredCapabilities ?? [], 512, 256, 'requiredCapabilities'),
      resourceKeys: uniqueStrings(input.resourceKeys ?? [], MAX_ITEMS, 1024, 'resourceKeys'),
      artifactDigests: normalizeArtifacts(input.artifactDigests ?? []),
      worldAssumptions: normalizeAssumptions(input.worldAssumptions ?? []),
      completedStepDigests: uniqueDigests(input.completedStepDigests ?? [], MAX_ITEMS, 'completedStepDigests'),
      ...(input.verificationDigest ? { verificationDigest: digest(input.verificationDigest, 'verificationDigest') } : {}),
      continuation: safeContinuation(input.continuation)
    };
    const signature = await this.#identity.sign(checkpointPayload(checkpoint));
    return { checkpoint, signature };
  }

  async verifyAndAccept(envelopeInput: SignedSemanticCheckpoint, options: {
    expectedAuthorityDigest: string;
    expectedWorkloadId?: string;
    expectedStateDigest?: string;
    availableCapabilities?: string[];
    verifyResourceKey?: (resourceKey: string) => Promise<boolean>;
    verifyWorldAssumption?: (assumption: SemanticWorldAssumption) => Promise<string | undefined>;
    verifyArtifact?: (artifact: SemanticCheckpointArtifact) => Promise<{ digest: string; size?: number } | undefined>;
  }): Promise<SemanticCheckpoint> {
    const envelope = normalizeEnvelope(envelopeInput);
    const checkpoint = envelope.checkpoint;
    const now = this.#clock();
    if (Date.parse(checkpoint.expiresAt) <= now.getTime()) {
      throw new OperatorError('SEMANTIC_CHECKPOINT_EXPIRED', 'Semantic checkpoint has expired.');
    }
    if (Date.parse(checkpoint.createdAt) > now.getTime() + 30_000) {
      throw new OperatorError('SEMANTIC_CHECKPOINT_FUTURE_DATED', 'Semantic checkpoint is future-dated.');
    }
    if (options.expectedWorkloadId && checkpoint.workloadId !== uuid(options.expectedWorkloadId, 'expectedWorkloadId')) {
      throw new OperatorError('SEMANTIC_CHECKPOINT_WORKLOAD_MISMATCH', 'Semantic checkpoint belongs to another workload.');
    }

    const devices = await this.#registry.listDevices();
    const trusted = devices.find((device) => device.deviceId === checkpoint.sourceDeviceId);
    if (!trusted) throw new OperatorError('SEMANTIC_CHECKPOINT_SOURCE_UNTRUSTED', 'Semantic checkpoint source device is not paired.');
    if (trusted.status !== 'active') throw new OperatorError('SEMANTIC_CHECKPOINT_SOURCE_REVOKED', 'Semantic checkpoint source device is revoked.');
    const verified = await this.#registry.verifyDeviceSignature(
      checkpoint.sourceDeviceId,
      checkpointPayload(checkpoint),
      envelope.signature
    );
    if (!verified) throw new OperatorError('SEMANTIC_CHECKPOINT_SIGNATURE_INVALID', 'Semantic checkpoint signature is invalid.');

    const expectedAuthorityDigest = digest(options.expectedAuthorityDigest, 'expectedAuthorityDigest');
    if (checkpoint.authorityDigest !== expectedAuthorityDigest) {
      throw new OperatorError('SEMANTIC_CHECKPOINT_AUTHORITY_MISMATCH', 'Semantic checkpoint authority envelope does not match the destination contract.');
    }
    if (options.expectedStateDigest && checkpoint.stateDigest !== digest(options.expectedStateDigest, 'expectedStateDigest')) {
      throw new OperatorError('SEMANTIC_CHECKPOINT_STATE_MISMATCH', 'Semantic checkpoint state digest does not match the destination continuation contract.');
    }

    if (checkpoint.requiredCapabilities.length > 0) {
      if (!Array.isArray(options.availableCapabilities)) {
        throw new OperatorError('SEMANTIC_CHECKPOINT_CAPABILITY_PROOF_REQUIRED', 'Destination capability proof is required before accepting this checkpoint.');
      }
      const available = new Set(uniqueStrings(options.availableCapabilities, 2048, 256, 'availableCapabilities'));
      const missing = checkpoint.requiredCapabilities.filter((capability) => !available.has(capability));
      if (missing.length > 0) {
        throw new OperatorError('SEMANTIC_CHECKPOINT_CAPABILITY_MISMATCH', 'Destination cannot satisfy all checkpoint capability requirements.', {
          details: { missing }
        });
      }
    }

    if (checkpoint.resourceKeys.length > 0) {
      if (!options.verifyResourceKey) {
        throw new OperatorError('SEMANTIC_CHECKPOINT_RESOURCE_PROOF_REQUIRED', 'Destination resource-scope proof is required before accepting this checkpoint.');
      }
      const denied: string[] = [];
      for (const resourceKey of checkpoint.resourceKeys) {
        if (!await options.verifyResourceKey(resourceKey)) denied.push(resourceKey);
      }
      if (denied.length > 0) {
        throw new OperatorError('SEMANTIC_CHECKPOINT_RESOURCE_MISMATCH', 'Destination authority does not cover all checkpoint resources.', {
          details: { denied: denied.slice(0, 100) }
        });
      }
    }

    if (checkpoint.worldAssumptions.length > 0) {
      if (!options.verifyWorldAssumption) {
        throw new OperatorError('SEMANTIC_CHECKPOINT_WORLD_PROOF_REQUIRED', 'Destination world-assumption verification is required before accepting this checkpoint.');
      }
      for (const assumption of checkpoint.worldAssumptions) {
        const actual = await options.verifyWorldAssumption(structuredClone(assumption));
        if (!actual || digest(actual, 'world assumption verification digest') !== assumption.valueDigest) {
          throw new OperatorError('SEMANTIC_CHECKPOINT_WORLD_MISMATCH', `World assumption ${assumption.entityKey}.${assumption.factKey} is stale or unavailable.`);
        }
      }
    }

    if (checkpoint.artifactDigests.length > 0) {
      if (!options.verifyArtifact) {
        throw new OperatorError('SEMANTIC_CHECKPOINT_ARTIFACT_PROOF_REQUIRED', 'Destination artifact verification is required before accepting this checkpoint.');
      }
      for (const artifact of checkpoint.artifactDigests) {
        const actual = await options.verifyArtifact(structuredClone(artifact));
        if (!actual || digest(actual.digest, 'artifact verification digest') !== artifact.digest
          || (artifact.size !== undefined && actual.size !== artifact.size)) {
          throw new OperatorError('SEMANTIC_CHECKPOINT_ARTIFACT_MISMATCH', `Artifact ${artifact.key} does not match the signed checkpoint.`);
        }
      }
    }

    const fullCheckpointDigest = semanticCheckpointDigest(checkpoint);
    await this.#mutate((state) => {
      const existing = state.accepted.find((item) => item.checkpointId === checkpoint.checkpointId);
      if (existing) {
        if (existing.checkpointDigest !== fullCheckpointDigest || existing.sourceDeviceId !== checkpoint.sourceDeviceId) {
          throw new OperatorError('SEMANTIC_CHECKPOINT_REPLAY_CONFLICT', 'Checkpoint ID was previously accepted with different signed content.');
        }
        return;
      }
      state.accepted.push({
        checkpointId: checkpoint.checkpointId,
        workloadId: checkpoint.workloadId,
        sourceDeviceId: checkpoint.sourceDeviceId,
        acceptedAt: now.toISOString(),
        stateDigest: checkpoint.stateDigest,
        authorityDigest: checkpoint.authorityDigest,
        checkpointDigest: fullCheckpointDigest
      });
      if (state.accepted.length > MAX_ITEMS) state.accepted.splice(0, state.accepted.length - MAX_ITEMS);
    });
    return structuredClone(checkpoint);
  }

  async #mutate(fn: (state: MigrationState) => void): Promise<void> {
    const run = this.#serial.then(() => withDurableStateLock(this.#file, async () => {
      const state = await this.#read();
      fn(state);
      await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STORE_OPTIONS);
    }));
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
  }

  async #read(): Promise<MigrationState> {
    try {
      const state = JSON.parse(await readDurableStateText(this.#file, STORE_OPTIONS)) as MigrationState;
      if (state.version !== 1 || !Array.isArray(state.accepted) || state.accepted.length > MAX_ITEMS) throw new Error('shape');
      for (const item of state.accepted) {
        uuid(item.checkpointId, 'checkpointId');
        uuid(item.workloadId, 'workloadId');
        uuid(item.sourceDeviceId, 'sourceDeviceId');
        iso(item.acceptedAt, 'acceptedAt');
        digest(item.stateDigest, 'stateDigest');
        digest(item.authorityDigest, 'authorityDigest');
        digest(item.checkpointDigest, 'checkpointDigest');
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, accepted: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('SEMANTIC_MIGRATION_CORRUPT', 'Semantic migration state could not be read.');
    }
  }
}

export function semanticCheckpointDigest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function checkpointPayload(checkpoint: SemanticCheckpoint): Buffer {
  return Buffer.from(canonicalJson(checkpoint), 'utf8');
}

function normalizeEnvelope(input: SignedSemanticCheckpoint): SignedSemanticCheckpoint {
  if (!input || typeof input !== 'object') throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', 'Semantic checkpoint envelope is invalid.');
  const signature = String(input.signature ?? '');
  if (!/^[A-Za-z0-9_-]{40,256}$/.test(signature)) throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', 'Semantic checkpoint signature is malformed.');
  const raw = input.checkpoint;
  if (!raw || raw.version !== 1) throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', 'Semantic checkpoint version is invalid.');
  const checkpoint: SemanticCheckpoint = {
    version: 1,
    checkpointId: uuid(raw.checkpointId, 'checkpointId'),
    workloadKind: workloadKind(raw.workloadKind),
    workloadId: uuid(raw.workloadId, 'workloadId'),
    sourceDeviceId: uuid(raw.sourceDeviceId, 'sourceDeviceId'),
    createdAt: iso(raw.createdAt, 'createdAt'),
    expiresAt: iso(raw.expiresAt, 'expiresAt'),
    objectiveDigest: digest(raw.objectiveDigest, 'objectiveDigest'),
    stateDigest: digest(raw.stateDigest, 'stateDigest'),
    authorityDigest: digest(raw.authorityDigest, 'authorityDigest'),
    requiredCapabilities: uniqueStrings(raw.requiredCapabilities, 512, 256, 'requiredCapabilities'),
    resourceKeys: uniqueStrings(raw.resourceKeys, MAX_ITEMS, 1024, 'resourceKeys'),
    artifactDigests: normalizeArtifacts(raw.artifactDigests),
    worldAssumptions: normalizeAssumptions(raw.worldAssumptions),
    completedStepDigests: uniqueDigests(raw.completedStepDigests, MAX_ITEMS, 'completedStepDigests'),
    ...(raw.verificationDigest ? { verificationDigest: digest(raw.verificationDigest, 'verificationDigest') } : {}),
    continuation: safeContinuation(raw.continuation)
  };
  if (Date.parse(checkpoint.expiresAt) <= Date.parse(checkpoint.createdAt)
    || Date.parse(checkpoint.expiresAt) - Date.parse(checkpoint.createdAt) > MAX_TTL_MS) {
    throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', 'Semantic checkpoint lifetime is invalid.');
  }
  return { checkpoint, signature };
}

function safeContinuation(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', 'continuation must be an object.');
  assertSafeValue(input, 'continuation', 0);
  const encoded = canonicalJson(input);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_CONTINUATION_BYTES) throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', 'continuation exceeds the bounded migration size.');
  return JSON.parse(encoded) as Record<string, unknown>;
}

function assertSafeValue(value: unknown, label: string, depth: number): void {
  if (depth > 10) throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', `${label} exceeds maximum depth.`);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    if (value.length > 64 * 1024 || value.includes('\0')) throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', `${label} contains an invalid string.`);
    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(value)
      || /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/i.test(value)
      || /\bAKIA[0-9A-Z]{16}\b/.test(value)
      || /\bsk-[A-Za-z0-9_-]{20,}\b/.test(value)) {
      throw new OperatorError('SEMANTIC_CHECKPOINT_SECRET_REJECTED', `${label} appears to contain credential material.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ITEMS) throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', `${label} array is too large.`);
    value.forEach((child, index) => assertSafeValue(child, `${label}[${index}]`, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_ITEMS) throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', `${label} object is too large.`);
    for (const [key, child] of entries) {
      if (!key || key.length > 256 || key.includes('\0')) throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', `${label} has an invalid key.`);
      if (SECRET_KEY.test(key)) throw new OperatorError('SEMANTIC_CHECKPOINT_SECRET_REJECTED', `${label} contains a secret-bearing key.`);
      assertSafeValue(child, `${label}.${key}`, depth + 1);
    }
    return;
  }
  throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', `${label} contains an unsupported value.`);
}

function normalizeArtifacts(input: SemanticCheckpointArtifact[]): SemanticCheckpointArtifact[] {
  if (!Array.isArray(input) || input.length > MAX_ITEMS) throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', 'artifactDigests is invalid.');
  return input.map((item, index) => ({
    key: bounded(item.key, 1024, `artifactDigests[${index}].key`),
    digest: digest(item.digest, `artifactDigests[${index}].digest`),
    ...(item.size === undefined ? {} : { size: boundedInteger(item.size, 0, Number.MAX_SAFE_INTEGER, `artifactDigests[${index}].size`) })
  })).sort((a, b) => a.key.localeCompare(b.key));
}

function normalizeAssumptions(input: SemanticWorldAssumption[]): SemanticWorldAssumption[] {
  if (!Array.isArray(input) || input.length > MAX_ITEMS) throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', 'worldAssumptions is invalid.');
  return input.map((item, index) => ({
    entityKey: bounded(item.entityKey, 512, `worldAssumptions[${index}].entityKey`),
    factKey: bounded(item.factKey, 128, `worldAssumptions[${index}].factKey`),
    valueDigest: digest(item.valueDigest, `worldAssumptions[${index}].valueDigest`)
  })).sort((a, b) => `${a.entityKey}\0${a.factKey}`.localeCompare(`${b.entityKey}\0${b.factKey}`));
}

function uniqueStrings(input: unknown, maxItems: number, maxLength: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > maxItems) throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', `${label} is invalid.`);
  const values = input.map((value, index) => bounded(value, maxLength, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', `${label} contains duplicates.`);
  return values.sort();
}

function uniqueDigests(input: unknown, maxItems: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > maxItems) throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', `${label} is invalid.`);
  const values = input.map((value, index) => digest(value, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', `${label} contains duplicates.`);
  return values.sort();
}

function workloadKind(input: unknown): MigratableWorkloadKind {
  if (input !== 'task' && input !== 'mission' && input !== 'operation') throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', 'workloadKind is invalid.');
  return input;
}

function bounded(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0')) throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', `${label} is invalid.`);
  return input;
}
function boundedInteger(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', `${label} is invalid.`);
  return value;
}
function uuid(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', `${label} must be UUID.`);
  return value;
}
function digest(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', `${label} must be SHA-256.`);
  return value;
}
function iso(input: unknown, label: string): string {
  const value = String(input ?? '');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new OperatorError('SEMANTIC_CHECKPOINT_INVALID', `${label} must be an ISO timestamp.`);
  return value;
}
