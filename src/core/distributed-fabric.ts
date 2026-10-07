import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { OperatorError } from './errors.ts';

export type DistributedWorkerRole =
  | 'INVESTIGATE'
  | 'CHANGE'
  | 'TEST'
  | 'UI_VALIDATE'
  | 'PERFORMANCE'
  | 'VERIFY'
  | 'PACKAGE_RELEASE'
  | 'RECOVERY';

export interface DistributedWorkFence {
  schemaVersion: 1;
  id: string;
  objectiveId: string;
  workUnitId: string;
  role: DistributedWorkerRole;
  placementKey: string;
  reservationId: string;
  deviceId: string;
  sessionId: string;
  authorityDigest: string;
  generation: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  state: 'ACTIVE' | 'RELEASED' | 'EXPIRED';
}

export interface DistributedArtifactHandoff {
  schemaVersion: 1;
  id: string;
  objectiveId: string;
  workUnitId: string;
  fromFenceId: string;
  toFenceId: string;
  artifactIds: string[];
  evidenceArtifactIds: string[];
  createdAt: string;
}

interface FenceState {
  version: 1;
  fences: DistributedWorkFence[];
}

const STORE_OPTIONS = {
  maxBytes: 16 * 1024 * 1024,
  errorCode: 'DISTRIBUTED_FABRIC_STATE_CORRUPT',
  invalidMessage: 'Distributed fabric state is invalid.'
} as const;
const MIN_LEASE_MS = 10_000;
const MAX_LEASE_MS = 24 * 60 * 60_000;
const MAX_FENCES = 100_000;

export class DistributedWorkFenceStore {
  #file: string;
  #clock: () => Date;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: { clock?: () => Date } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'distributed-work-fences.json');
    this.#clock = options.clock ?? (() => new Date());
  }

  async acquire(input: {
    objectiveId: string;
    workUnitId: string;
    role: DistributedWorkerRole;
    placementKey: string;
    reservationId: string;
    deviceId: string;
    sessionId: string;
    authorityDigest: string;
    leaseMs?: number;
  }): Promise<DistributedWorkFence> {
    const normalized = normalizeAcquire(input);
    const leaseMs = integer(input.leaseMs ?? 5 * 60_000, MIN_LEASE_MS, MAX_LEASE_MS, 'leaseMs');
    let result!: DistributedWorkFence;
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      const now = this.#clock();
      expire(state, now.getTime());
      const active = state.fences.find((item) =>
        item.objectiveId === normalized.objectiveId &&
        item.workUnitId === normalized.workUnitId &&
        item.state === 'ACTIVE'
      );
      if (active) {
        throw new OperatorError('DISTRIBUTED_WORK_FENCED', 'Work unit already has an active distributed owner.', {
          retryable: true,
          details: { activeFenceId: active.id, generation: active.generation, deviceId: active.deviceId }
        });
      }
      const previousGeneration = state.fences
        .filter((item) => item.objectiveId === normalized.objectiveId && item.workUnitId === normalized.workUnitId)
        .reduce((max, item) => Math.max(max, item.generation), 0);
      if (previousGeneration >= Number.MAX_SAFE_INTEGER) throw invalid('Fence generation is exhausted.');
      if (state.fences.length >= MAX_FENCES) {
        const reclaim = state.fences.findIndex((item) => item.state !== 'ACTIVE');
        if (reclaim < 0) throw invalid('Fence store capacity is exhausted.');
        state.fences.splice(reclaim, 1);
      }
      const body = {
        schemaVersion: 1 as const,
        ...normalized,
        generation: previousGeneration + 1,
        acquiredAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
        state: 'ACTIVE' as const
      };
      result = { ...body, id: fenceId(body) };
      state.fences.push(result);
      await this.#write(state);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
    return structuredClone(result);
  }

  async heartbeat(input: {
    fenceId: string;
    generation: number;
    sessionId: string;
    leaseMs?: number;
  }): Promise<DistributedWorkFence> {
    const fenceId = digest(input.fenceId, 'fenceId');
    const generation = integer(input.generation, 1, Number.MAX_SAFE_INTEGER, 'generation');
    const sessionId = id(input.sessionId, 'sessionId');
    const leaseMs = integer(input.leaseMs ?? 5 * 60_000, MIN_LEASE_MS, MAX_LEASE_MS, 'leaseMs');
    let result!: DistributedWorkFence;
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      const now = this.#clock();
      expire(state, now.getTime());
      const fence = state.fences.find((item) => item.id === fenceId);
      if (!fence || fence.state !== 'ACTIVE') throw new OperatorError('DISTRIBUTED_FENCE_LOST', 'Distributed work fence is no longer active.');
      if (fence.generation !== generation || fence.sessionId !== sessionId) throw new OperatorError('DISTRIBUTED_FENCE_STALE', 'Distributed work fence generation or device session changed.');
      fence.heartbeatAt = now.toISOString();
      fence.expiresAt = new Date(now.getTime() + leaseMs).toISOString();
      result = structuredClone(fence);
      await this.#write(state);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
    return result;
  }

  async release(input: { fenceId: string; generation: number; sessionId: string }): Promise<DistributedWorkFence> {
    const fenceId = digest(input.fenceId, 'fenceId');
    const generation = integer(input.generation, 1, Number.MAX_SAFE_INTEGER, 'generation');
    const sessionId = id(input.sessionId, 'sessionId');
    let result!: DistributedWorkFence;
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      const fence = state.fences.find((item) => item.id === fenceId);
      if (!fence) throw new OperatorError('DISTRIBUTED_FENCE_NOT_FOUND', 'Distributed work fence was not found.');
      if (fence.generation !== generation || fence.sessionId !== sessionId) throw new OperatorError('DISTRIBUTED_FENCE_STALE', 'Distributed work fence generation or device session changed.');
      if (fence.state === 'ACTIVE') fence.state = 'RELEASED';
      result = structuredClone(fence);
      await this.#write(state);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
    return result;
  }

  async assertCurrent(input: {
    fenceId: string;
    generation: number;
    authorityDigest: string;
    placementKey: string;
    now?: string;
  }): Promise<DistributedWorkFence> {
    await this.#serial;
    const state = await this.#read();
    const now = input.now ? Date.parse(iso(input.now, 'now')) : this.#clock().getTime();
    expire(state, now);
    const fence = state.fences.find((item) => item.id === digest(input.fenceId, 'fenceId'));
    if (!fence || fence.state !== 'ACTIVE') throw new OperatorError('DISTRIBUTED_FENCE_LOST', 'Distributed work fence is no longer active.');
    if (fence.generation !== integer(input.generation, 1, Number.MAX_SAFE_INTEGER, 'generation')) throw new OperatorError('DISTRIBUTED_FENCE_STALE', 'Distributed work fence generation changed.');
    if (fence.authorityDigest !== digest(input.authorityDigest, 'authorityDigest')) throw new OperatorError('DISTRIBUTED_FENCE_AUTHORITY_CHANGED', 'Authority changed after distributed placement.');
    if (fence.placementKey !== digest(input.placementKey, 'placementKey')) throw new OperatorError('DISTRIBUTED_FENCE_PLACEMENT_CHANGED', 'Placement identity changed after work was fenced.');
    return structuredClone(fence);
  }

  async list(input: { objectiveId?: string; activeOnly?: boolean; limit?: number } = {}): Promise<DistributedWorkFence[]> {
    await this.#serial;
    const state = await this.#read();
    expire(state, this.#clock().getTime());
    const objectiveId = input.objectiveId === undefined ? undefined : id(input.objectiveId, 'objectiveId');
    const limit = integer(input.limit ?? 100, 1, 5000, 'limit');
    return state.fences
      .filter((item) => (!objectiveId || item.objectiveId === objectiveId) && (!input.activeOnly || item.state === 'ACTIVE'))
      .sort((a, b) => b.generation - a.generation || b.acquiredAt.localeCompare(a.acquiredAt))
      .slice(0, limit)
      .map((item) => structuredClone(item));
  }

  async #read(): Promise<FenceState> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, STORE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, fences: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('DISTRIBUTED_FABRIC_STATE_CORRUPT', 'Distributed fabric state could not be read.');
    }
  }

  async #write(state: FenceState): Promise<void> {
    validateState(state);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STORE_OPTIONS);
  }
}

export function createDistributedArtifactHandoff(input: {
  objectiveId: string;
  workUnitId: string;
  fromFenceId: string;
  toFenceId: string;
  artifactIds: string[];
  evidenceArtifactIds: string[];
  createdAt?: string;
}): DistributedArtifactHandoff {
  const normalized = {
    schemaVersion: 1 as const,
    objectiveId: id(input.objectiveId, 'objectiveId'),
    workUnitId: id(input.workUnitId, 'workUnitId'),
    fromFenceId: digest(input.fromFenceId, 'fromFenceId'),
    toFenceId: digest(input.toFenceId, 'toFenceId'),
    artifactIds: uniqueDigests(input.artifactIds, 'artifactIds'),
    evidenceArtifactIds: uniqueDigests(input.evidenceArtifactIds, 'evidenceArtifactIds'),
    createdAt: iso(input.createdAt ?? new Date().toISOString(), 'createdAt')
  };
  if (normalized.fromFenceId === normalized.toFenceId) throw invalid('Artifact handoff requires different source and destination fences.');
  if (normalized.artifactIds.length === 0) throw invalid('Artifact handoff requires at least one artifact.');
  if (normalized.evidenceArtifactIds.length === 0) throw invalid('Artifact handoff requires causal evidence.');
  return { ...normalized, id: sha256(canonicalJson(normalized)) };
}

export function validateDistributedArtifactHandoff(input: DistributedArtifactHandoff): DistributedArtifactHandoff {
  if (!input || input.schemaVersion !== 1 || typeof input.id !== 'string') throw invalid('Artifact handoff shape is invalid.');
  const normalized = createDistributedArtifactHandoff(input);
  if (normalized.id !== input.id) throw invalid('Artifact handoff id does not match its content.');
  return normalized;
}

function normalizeAcquire(input: {
  objectiveId: string;
  workUnitId: string;
  role: DistributedWorkerRole;
  placementKey: string;
  reservationId: string;
  deviceId: string;
  sessionId: string;
  authorityDigest: string;
}) {
  if (!['INVESTIGATE','CHANGE','TEST','UI_VALIDATE','PERFORMANCE','VERIFY','PACKAGE_RELEASE','RECOVERY'].includes(input.role)) throw invalid('Distributed worker role is invalid.');
  return {
    objectiveId: id(input.objectiveId, 'objectiveId'),
    workUnitId: id(input.workUnitId, 'workUnitId'),
    role: input.role,
    placementKey: digest(input.placementKey, 'placementKey'),
    reservationId: id(input.reservationId, 'reservationId'),
    deviceId: id(input.deviceId, 'deviceId'),
    sessionId: id(input.sessionId, 'sessionId'),
    authorityDigest: digest(input.authorityDigest, 'authorityDigest')
  };
}

function validateState(input: unknown): FenceState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('State must be an object.');
  const state = input as FenceState;
  if (state.version !== 1 || !Array.isArray(state.fences) || state.fences.length > MAX_FENCES) throw corrupt('State shape is invalid.');
  const ids = new Set<string>();
  const activeWork = new Set<string>();
  for (const fence of state.fences) {
    const normalized = {
      schemaVersion: 1 as const,
      objectiveId: id(fence.objectiveId, 'objectiveId'),
      workUnitId: id(fence.workUnitId, 'workUnitId'),
      role: fence.role,
      placementKey: digest(fence.placementKey, 'placementKey'),
      reservationId: id(fence.reservationId, 'reservationId'),
      deviceId: id(fence.deviceId, 'deviceId'),
      sessionId: id(fence.sessionId, 'sessionId'),
      authorityDigest: digest(fence.authorityDigest, 'authorityDigest'),
      generation: integer(fence.generation, 1, Number.MAX_SAFE_INTEGER, 'generation'),
      acquiredAt: iso(fence.acquiredAt, 'acquiredAt')
    };
    iso(fence.heartbeatAt, 'heartbeatAt');
    iso(fence.expiresAt, 'expiresAt');
    const expected = fenceId(normalized);
    if (!['ACTIVE','RELEASED','EXPIRED'].includes(fence.state) || expected !== digest(fence.id, 'fence.id')) throw corrupt('Fence record integrity is invalid.');
    if (ids.has(fence.id)) throw corrupt('Fence ids must be unique.');
    ids.add(fence.id);
    if (fence.state === 'ACTIVE') {
      const key = fence.objectiveId + '\0' + fence.workUnitId;
      if (activeWork.has(key)) throw corrupt('Multiple active fences exist for one work unit.');
      activeWork.add(key);
    }
  }
  return structuredClone(state);
}

function expire(state: FenceState, now: number): void {
  for (const fence of state.fences) {
    if (fence.state === 'ACTIVE' && Date.parse(fence.expiresAt) <= now) fence.state = 'EXPIRED';
  }
}

function id(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!/^[A-Za-z0-9._:@/+-=]{1,256}$/.test(value)) throw invalid(label + ' is invalid.');
  return value;
}
function digest(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw invalid(label + ' must be SHA-256.');
  return value;
}
function uniqueDigests(input: unknown, label: string): string[] {
  if (!Array.isArray(input) || input.length > 100_000) throw invalid(label + ' is invalid.');
  return [...new Set(input.map((item) => digest(item, label)))].sort();
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
function fenceId(input: {
  schemaVersion: 1;
  objectiveId: string;
  workUnitId: string;
  role: DistributedWorkerRole;
  placementKey: string;
  reservationId: string;
  deviceId: string;
  sessionId: string;
  authorityDigest: string;
  generation: number;
  acquiredAt: string;
}): string {
  return sha256(canonicalJson({
    schemaVersion: 1,
    objectiveId: input.objectiveId,
    workUnitId: input.workUnitId,
    role: input.role,
    placementKey: input.placementKey,
    reservationId: input.reservationId,
    deviceId: input.deviceId,
    sessionId: input.sessionId,
    authorityDigest: input.authorityDigest,
    generation: input.generation,
    acquiredAt: input.acquiredAt
  }));
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
function invalid(message: string): OperatorError {
  return new OperatorError('DISTRIBUTED_FABRIC_INVALID', message);
}
function corrupt(message: string): OperatorError {
  return new OperatorError('DISTRIBUTED_FABRIC_STATE_CORRUPT', message);
}
