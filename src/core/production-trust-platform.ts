import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { OperatorError } from './errors.ts';
import type { OperationSloSummary } from './operation-trace.ts';

export interface ProductionSloPolicy {
  minVerificationRate: number;
  maxFalseCompletionRate: number;
  maxUncertainRate: number;
  maxP95CompletionMs: number;
  minCrashFreeSessionRate: number;
  minUpdateSuccessRate: number;
}

export interface ProductionSloObservation {
  operation: OperationSloSummary;
  crashFreeSessionRate: number;
  updateSuccessRate: number;
}

export interface ProductionSloDecision {
  healthy: boolean;
  reasons: string[];
  metrics: {
    verificationRate: number;
    falseCompletionRate: number;
    uncertainRate: number;
    p95CompletionMs: number;
    crashFreeSessionRate: number;
    updateSuccessRate: number;
  };
}

export interface ProductionPlatformSloPolicy extends ProductionSloPolicy {
  minControlPlaneAvailability: number;
  minReconnectSuccessRate: number;
  maxP95DispatchMs: number;
  maxP95VerificationMs: number;
  maxQueueDepth: number;
  maxP95DeliveryAgeMs: number;
  maxP95ReconciliationMs: number;
  maxStateBytes: number;
  maxRetentionViolationCount: number;
}

export interface ProductionPlatformSloObservation extends ProductionSloObservation {
  controlPlaneAvailability: number;
  reconnectSuccessRate: number;
  p95DispatchMs: number;
  p95VerificationMs: number;
  queueDepth: number;
  p95DeliveryAgeMs: number;
  p95ReconciliationMs: number;
  stateBytes: number;
  retentionViolationCount: number;
}

export interface ProductionPlatformSloDecision extends ProductionSloDecision {
  metrics: ProductionSloDecision['metrics'] & {
    controlPlaneAvailability: number;
    reconnectSuccessRate: number;
    p95DispatchMs: number;
    p95VerificationMs: number;
    queueDepth: number;
    p95DeliveryAgeMs: number;
    p95ReconciliationMs: number;
    stateBytes: number;
    retentionViolationCount: number;
  };
}

export interface RelayOwnershipFence {
  schemaVersion: 1;
  resourceKey: string;
  ownerInstanceId: string;
  generation: number;
  token: string;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
}

interface RelayFenceState {
  version: 1;
  fences: RelayOwnershipFence[];
}

export interface UpdateRolloutWave {
  id: string;
  targetCount: number;
  minHealthyCount: number;
}

export interface UpdateRolloutState {
  schemaVersion: 1;
  id: string;
  version: string;
  channel: 'canary' | 'beta' | 'stable';
  waves: UpdateRolloutWave[];
  currentWave: number;
  state: 'READY' | 'RUNNING' | 'HALTED' | 'ROLLBACK_REQUIRED' | 'COMPLETED';
  completedTargets: number;
  healthyTargets: number;
  failedTargets: number;
  startedAt?: string;
  updatedAt: string;
  reason?: string;
}

const FENCE_OPTIONS = {
  maxBytes: 8 * 1024 * 1024,
  errorCode: 'RELAY_CLUSTER_FENCE_CORRUPT',
  invalidMessage: 'Relay cluster fence state is invalid.'
} as const;
const MAX_FENCES = 100_000;
const MIN_LEASE_MS = 5_000;
const MAX_LEASE_MS = 10 * 60_000;

export function evaluateProductionSlo(
  observation: ProductionSloObservation,
  policyInput: ProductionSloPolicy
): ProductionSloDecision {
  const policy = normalizePolicy(policyInput);
  const operation = observation.operation;
  if (!operation || !Number.isSafeInteger(operation.traces) || operation.traces < 0) throw invalid('Operation SLO summary is invalid.');
  const falseCompletionRate = operation.traces === 0 ? 0 : operation.falseCompletionCount / operation.traces;
  const uncertainRate = operation.traces === 0 ? 0 : operation.uncertain / operation.traces;
  const metrics = {
    verificationRate: boundedRatio(operation.verificationRate, 'verificationRate'),
    falseCompletionRate: boundedRatio(falseCompletionRate, 'falseCompletionRate'),
    uncertainRate: boundedRatio(uncertainRate, 'uncertainRate'),
    p95CompletionMs: finite(operation.p95CompletionMs, 0, 24 * 60 * 60_000, 'p95CompletionMs'),
    crashFreeSessionRate: boundedRatio(observation.crashFreeSessionRate, 'crashFreeSessionRate'),
    updateSuccessRate: boundedRatio(observation.updateSuccessRate, 'updateSuccessRate')
  };
  const reasons: string[] = [];
  if (metrics.verificationRate < policy.minVerificationRate) reasons.push('VERIFICATION_RATE_LOW');
  if (metrics.falseCompletionRate > policy.maxFalseCompletionRate) reasons.push('FALSE_COMPLETION_RATE_HIGH');
  if (metrics.uncertainRate > policy.maxUncertainRate) reasons.push('UNCERTAIN_RATE_HIGH');
  if (metrics.p95CompletionMs > policy.maxP95CompletionMs) reasons.push('P95_COMPLETION_LATENCY_HIGH');
  if (metrics.crashFreeSessionRate < policy.minCrashFreeSessionRate) reasons.push('CRASH_FREE_SESSION_RATE_LOW');
  if (metrics.updateSuccessRate < policy.minUpdateSuccessRate) reasons.push('UPDATE_SUCCESS_RATE_LOW');
  return { healthy: reasons.length === 0, reasons, metrics };
}


export function evaluateProductionPlatformSlo(
  observation: ProductionPlatformSloObservation,
  policyInput: ProductionPlatformSloPolicy
): ProductionPlatformSloDecision {
  const base = evaluateProductionSlo(observation, policyInput);
  const policy = {
    minControlPlaneAvailability: boundedRatio(policyInput.minControlPlaneAvailability, 'minControlPlaneAvailability'),
    minReconnectSuccessRate: boundedRatio(policyInput.minReconnectSuccessRate, 'minReconnectSuccessRate'),
    maxP95DispatchMs: finite(policyInput.maxP95DispatchMs, 0, 24 * 60 * 60_000, 'maxP95DispatchMs'),
    maxP95VerificationMs: finite(policyInput.maxP95VerificationMs, 0, 24 * 60 * 60_000, 'maxP95VerificationMs'),
    maxQueueDepth: integer(policyInput.maxQueueDepth, 0, 100_000_000, 'maxQueueDepth'),
    maxP95DeliveryAgeMs: finite(policyInput.maxP95DeliveryAgeMs, 0, 30 * 24 * 60 * 60_000, 'maxP95DeliveryAgeMs'),
    maxP95ReconciliationMs: finite(policyInput.maxP95ReconciliationMs, 0, 30 * 24 * 60 * 60_000, 'maxP95ReconciliationMs'),
    maxStateBytes: integer(policyInput.maxStateBytes, 1, Number.MAX_SAFE_INTEGER, 'maxStateBytes'),
    maxRetentionViolationCount: integer(policyInput.maxRetentionViolationCount, 0, 100_000_000, 'maxRetentionViolationCount')
  };
  const platform = {
    controlPlaneAvailability: boundedRatio(observation.controlPlaneAvailability, 'controlPlaneAvailability'),
    reconnectSuccessRate: boundedRatio(observation.reconnectSuccessRate, 'reconnectSuccessRate'),
    p95DispatchMs: finite(observation.p95DispatchMs, 0, 24 * 60 * 60_000, 'p95DispatchMs'),
    p95VerificationMs: finite(observation.p95VerificationMs, 0, 24 * 60 * 60_000, 'p95VerificationMs'),
    queueDepth: integer(observation.queueDepth, 0, 100_000_000, 'queueDepth'),
    p95DeliveryAgeMs: finite(observation.p95DeliveryAgeMs, 0, 30 * 24 * 60 * 60_000, 'p95DeliveryAgeMs'),
    p95ReconciliationMs: finite(observation.p95ReconciliationMs, 0, 30 * 24 * 60 * 60_000, 'p95ReconciliationMs'),
    stateBytes: integer(observation.stateBytes, 0, Number.MAX_SAFE_INTEGER, 'stateBytes'),
    retentionViolationCount: integer(observation.retentionViolationCount, 0, 100_000_000, 'retentionViolationCount')
  };
  const reasons = [...base.reasons];
  if (platform.controlPlaneAvailability < policy.minControlPlaneAvailability) reasons.push('CONTROL_PLANE_AVAILABILITY_LOW');
  if (platform.reconnectSuccessRate < policy.minReconnectSuccessRate) reasons.push('RECONNECT_SUCCESS_RATE_LOW');
  if (platform.p95DispatchMs > policy.maxP95DispatchMs) reasons.push('P95_DISPATCH_LATENCY_HIGH');
  if (platform.p95VerificationMs > policy.maxP95VerificationMs) reasons.push('P95_VERIFICATION_LATENCY_HIGH');
  if (platform.queueDepth > policy.maxQueueDepth) reasons.push('QUEUE_DEPTH_HIGH');
  if (platform.p95DeliveryAgeMs > policy.maxP95DeliveryAgeMs) reasons.push('P95_DELIVERY_AGE_HIGH');
  if (platform.p95ReconciliationMs > policy.maxP95ReconciliationMs) reasons.push('P95_RECONCILIATION_LATENCY_HIGH');
  if (platform.stateBytes > policy.maxStateBytes) reasons.push('STATE_GROWTH_HIGH');
  if (platform.retentionViolationCount > policy.maxRetentionViolationCount) reasons.push('RETENTION_COMPLIANCE_FAILED');
  return {
    healthy: reasons.length === 0,
    reasons,
    metrics: { ...base.metrics, ...platform }
  };
}

export class RelayOwnershipFenceStore {
  #file: string;
  #clock: () => Date;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: { clock?: () => Date } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'relay-cluster-fences.json');
    this.#clock = options.clock ?? (() => new Date());
  }

  async acquire(input: {
    resourceKey: string;
    ownerInstanceId: string;
    leaseMs?: number;
  }): Promise<RelayOwnershipFence> {
    const resourceKey = boundedId(input.resourceKey, 'resourceKey');
    const ownerInstanceId = boundedId(input.ownerInstanceId, 'ownerInstanceId');
    const leaseMs = integer(input.leaseMs ?? 30_000, MIN_LEASE_MS, MAX_LEASE_MS, 'leaseMs');
    let result!: RelayOwnershipFence;
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      const now = this.#clock();
      const existingIndex = state.fences.findIndex((fence) => fence.resourceKey === resourceKey);
      const existing = existingIndex >= 0 ? state.fences[existingIndex]! : undefined;
      if (existing && Date.parse(existing.expiresAt) > now.getTime()) {
        if (existing.ownerInstanceId !== ownerInstanceId) {
          throw new OperatorError('RELAY_CLUSTER_RESOURCE_FENCED', 'Relay resource is owned by another live instance.', {
            retryable: true,
            details: { resourceKey, generation: existing.generation }
          });
        }
        existing.renewedAt = now.toISOString();
        existing.expiresAt = new Date(now.getTime() + leaseMs).toISOString();
        result = structuredClone(existing);
        await this.#write(state);
        return;
      }
      const previous = existing?.generation ?? 0;
      if (previous >= Number.MAX_SAFE_INTEGER) throw invalid('Relay fence generation is exhausted.');
      if (!existing && state.fences.length >= MAX_FENCES) throw invalid('Relay fence store capacity is exhausted.');
      result = {
        schemaVersion: 1,
        resourceKey,
        ownerInstanceId,
        generation: previous + 1,
        token: crypto.randomBytes(32).toString('base64url'),
        acquiredAt: now.toISOString(),
        renewedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + leaseMs).toISOString()
      };
      if (existingIndex >= 0) state.fences[existingIndex] = result;
      else state.fences.push(result);
      await this.#write(state);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
    return result;
  }

  async assertCurrent(input: {
    resourceKey: string;
    ownerInstanceId: string;
    generation: number;
    token: string;
    now?: string;
  }): Promise<RelayOwnershipFence> {
    await this.#serial;
    const state = await this.#read();
    const now = input.now ? Date.parse(iso(input.now, 'now')) : this.#clock().getTime();
    const resourceKey = boundedId(input.resourceKey, 'resourceKey');
    const fence = state.fences.find((item) => item.resourceKey === resourceKey);
    if (!fence || Date.parse(fence.expiresAt) <= now) throw new OperatorError('RELAY_CLUSTER_FENCE_LOST', 'Relay resource ownership lease is no longer active.');
    if (
      fence.ownerInstanceId !== boundedId(input.ownerInstanceId, 'ownerInstanceId') ||
      fence.generation !== integer(input.generation, 1, Number.MAX_SAFE_INTEGER, 'generation') ||
      !timingSafeToken(fence.token, input.token)
    ) throw new OperatorError('RELAY_CLUSTER_FENCE_STALE', 'Relay resource ownership token is stale.');
    return structuredClone(fence);
  }

  async release(input: {
    resourceKey: string;
    ownerInstanceId: string;
    generation: number;
    token: string;
  }): Promise<boolean> {
    const current = await this.assertCurrent(input);
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      const index = state.fences.findIndex((item) =>
        item.resourceKey === current.resourceKey &&
        item.ownerInstanceId === current.ownerInstanceId &&
        item.generation === current.generation &&
        timingSafeToken(item.token, current.token)
      );
      if (index < 0) return false;
      const releasedAt = this.#clock().toISOString();
      state.fences[index] = { ...state.fences[index]!, renewedAt: releasedAt, expiresAt: releasedAt };
      await this.#write(state);
      return true;
    });
    this.#serial = run.then(() => undefined, () => undefined);
    return await run;
  }

  async #read(): Promise<RelayFenceState> {
    try {
      return validateFenceState(JSON.parse(await readDurableStateText(this.#file, FENCE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, fences: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('RELAY_CLUSTER_FENCE_CORRUPT', 'Relay cluster fence state could not be read.');
    }
  }

  async #write(state: RelayFenceState): Promise<void> {
    validateFenceState(state);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), FENCE_OPTIONS);
  }
}

export function createUpdateRollout(input: {
  version: string;
  channel: UpdateRolloutState['channel'];
  waves: UpdateRolloutWave[];
  now?: string;
}): UpdateRolloutState {
  const version = semver(input.version);
  if (!['canary','beta','stable'].includes(input.channel)) throw invalid('Update rollout channel is invalid.');
  const waves = normalizeWaves(input.waves);
  const updatedAt = iso(input.now ?? new Date().toISOString(), 'now');
  const identity = { version, channel: input.channel, waves };
  return {
    schemaVersion: 1,
    id: sha256(canonicalJson(identity)),
    version,
    channel: input.channel,
    waves,
    currentWave: 0,
    state: 'READY',
    completedTargets: 0,
    healthyTargets: 0,
    failedTargets: 0,
    updatedAt
  };
}

export function startUpdateRollout(stateInput: UpdateRolloutState, now = new Date().toISOString()): UpdateRolloutState {
  const state = normalizeRollout(stateInput);
  if (state.state !== 'READY') throw invalid('Only a ready rollout can start.');
  return { ...state, state: 'RUNNING', startedAt: iso(now, 'now'), updatedAt: iso(now, 'now') };
}

export function recordUpdateWaveResult(input: {
  state: UpdateRolloutState;
  completedTargets: number;
  healthyTargets: number;
  rollbackAvailable: boolean;
  slo: ProductionSloDecision;
  now?: string;
}): UpdateRolloutState {
  const state = normalizeRollout(input.state);
  if (state.state !== 'RUNNING') throw invalid('Only a running rollout accepts wave results.');
  const wave = state.waves[state.currentWave];
  if (!wave) throw invalid('Update rollout current wave is invalid.');
  const completedTargets = integer(input.completedTargets, 0, wave.targetCount, 'completedTargets');
  const healthyTargets = integer(input.healthyTargets, 0, completedTargets, 'healthyTargets');
  const failedTargets = completedTargets - healthyTargets;
  const updatedAt = iso(input.now ?? new Date().toISOString(), 'now');
  const waveHealthy = completedTargets === wave.targetCount && healthyTargets >= wave.minHealthyCount && input.slo.healthy;
  if (!waveHealthy) {
    return {
      ...state,
      completedTargets: state.completedTargets + completedTargets,
      healthyTargets: state.healthyTargets + healthyTargets,
      failedTargets: state.failedTargets + failedTargets,
      state: input.rollbackAvailable ? 'ROLLBACK_REQUIRED' : 'HALTED',
      reason: input.slo.healthy ? 'UPDATE_WAVE_HEALTH_THRESHOLD_FAILED' : input.slo.reasons.join(','),
      updatedAt
    };
  }
  const nextWave = state.currentWave + 1;
  return {
    ...state,
    currentWave: Math.min(nextWave, state.waves.length - 1),
    completedTargets: state.completedTargets + completedTargets,
    healthyTargets: state.healthyTargets + healthyTargets,
    failedTargets: state.failedTargets + failedTargets,
    state: nextWave >= state.waves.length ? 'COMPLETED' : 'RUNNING',
    updatedAt
  };
}

function normalizePolicy(input: ProductionSloPolicy): ProductionSloPolicy {
  return {
    minVerificationRate: boundedRatio(input.minVerificationRate, 'minVerificationRate'),
    maxFalseCompletionRate: boundedRatio(input.maxFalseCompletionRate, 'maxFalseCompletionRate'),
    maxUncertainRate: boundedRatio(input.maxUncertainRate, 'maxUncertainRate'),
    maxP95CompletionMs: finite(input.maxP95CompletionMs, 1, 24 * 60 * 60_000, 'maxP95CompletionMs'),
    minCrashFreeSessionRate: boundedRatio(input.minCrashFreeSessionRate, 'minCrashFreeSessionRate'),
    minUpdateSuccessRate: boundedRatio(input.minUpdateSuccessRate, 'minUpdateSuccessRate')
  };
}

function normalizeWaves(input: UpdateRolloutWave[]): UpdateRolloutWave[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 32) throw invalid('Update rollout waves are invalid.');
  const ids = new Set<string>();
  return input.map((wave) => {
    const id = boundedId(wave.id, 'wave.id');
    if (ids.has(id)) throw invalid('Update rollout wave ids must be unique.');
    ids.add(id);
    const targetCount = integer(wave.targetCount, 1, 10_000_000, 'wave.targetCount');
    const minHealthyCount = integer(wave.minHealthyCount, 1, targetCount, 'wave.minHealthyCount');
    return { id, targetCount, minHealthyCount };
  });
}

function normalizeRollout(input: UpdateRolloutState): UpdateRolloutState {
  if (!input || input.schemaVersion !== 1) throw invalid('Update rollout is invalid.');
  const waves = normalizeWaves(input.waves);
  const state = String(input.state) as UpdateRolloutState['state'];
  if (!['READY','RUNNING','HALTED','ROLLBACK_REQUIRED','COMPLETED'].includes(state)) throw invalid('Update rollout state is invalid.');
  const normalized: UpdateRolloutState = {
    schemaVersion: 1,
    id: digest(input.id, 'rollout.id'),
    version: semver(input.version),
    channel: input.channel,
    waves,
    currentWave: integer(input.currentWave, 0, waves.length - 1, 'currentWave'),
    state,
    completedTargets: integer(input.completedTargets, 0, 100_000_000, 'completedTargets'),
    healthyTargets: integer(input.healthyTargets, 0, 100_000_000, 'healthyTargets'),
    failedTargets: integer(input.failedTargets, 0, 100_000_000, 'failedTargets'),
    ...(input.startedAt ? { startedAt: iso(input.startedAt, 'startedAt') } : {}),
    updatedAt: iso(input.updatedAt, 'updatedAt'),
    ...(input.reason ? { reason: boundedText(input.reason, 2048, 'reason') } : {})
  };
  const expected = sha256(canonicalJson({ version: normalized.version, channel: normalized.channel, waves: normalized.waves }));
  if (normalized.id !== expected) throw invalid('Update rollout id does not match its immutable definition.');
  return normalized;
}

function validateFenceState(input: unknown): RelayFenceState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('State must be an object.');
  const state = input as RelayFenceState;
  if (state.version !== 1 || !Array.isArray(state.fences) || state.fences.length > MAX_FENCES) throw corrupt('State shape is invalid.');
  const resources = new Set<string>();
  for (const fence of state.fences) {
    if (!fence || fence.schemaVersion !== 1) throw corrupt('Fence shape is invalid.');
    boundedId(fence.resourceKey, 'resourceKey');
    boundedId(fence.ownerInstanceId, 'ownerInstanceId');
    integer(fence.generation, 1, Number.MAX_SAFE_INTEGER, 'generation');
    if (!/^[A-Za-z0-9_-]{40,128}$/.test(fence.token)) throw corrupt('Fence token is invalid.');
    iso(fence.acquiredAt, 'acquiredAt'); iso(fence.renewedAt, 'renewedAt'); iso(fence.expiresAt, 'expiresAt');
    if (resources.has(fence.resourceKey)) throw corrupt('Multiple owners exist for one relay resource.');
    resources.add(fence.resourceKey);
  }
  return structuredClone(state);
}
function timingSafeToken(expected: string, supplied: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(String(supplied ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function boundedId(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!/^[A-Za-z0-9._:@/+-=]{1,512}$/.test(value)) throw invalid(label + ' is invalid.');
  return value;
}
function boundedText(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0') || Buffer.byteLength(input, 'utf8') > max) throw invalid(label + ' is invalid.');
  return input.trim();
}
function semver(input: unknown): string {
  const value = String(input ?? '');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) throw invalid('version must be SemVer.');
  return value;
}
function boundedRatio(input: unknown, label: string): number {
  return finite(input, 0, 1, label);
}
function finite(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value < min || value > max) throw invalid(label + ' is invalid.');
  return value;
}
function integer(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(label + ' is invalid.');
  return value;
}
function iso(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!value || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw invalid(label + ' must be canonical ISO.');
  return value;
}
function digest(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw invalid(label + ' must be SHA-256.');
  return value;
}
function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
function invalid(message: string): OperatorError {
  return new OperatorError('PRODUCTION_TRUST_INVALID', message);
}
function corrupt(message: string): OperatorError {
  return new OperatorError('RELAY_CLUSTER_FENCE_CORRUPT', message);
}
