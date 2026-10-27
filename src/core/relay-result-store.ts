import crypto from 'node:crypto';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { withDurableStateLock } from './durable-state-lock.ts';
import type { ControlPlaneStore } from './control-plane-store.ts';
import type { RelayDeliveryAuthority } from './relay-delivery-store.ts';
import type { PipelineLatencyRecorder } from './pipeline-latency.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

const MAX_STREAMS = 10_000;
const MAX_RESULTS_PER_STREAM = 10_000;
const MAX_RESULT_BYTES = 256 * 1024;
const DEFAULT_RETENTION_MS = 24 * 60 * 60_000;
const MAX_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_WAITERS = 20_000;
const WAIT_FALLBACK_POLL_MS = 50;

type JsonObject = Record<string, unknown>;

// Bounded waiters share a single storage poll. 1000 waiting RPC calls must
// not start 1000 full-ledger JSON parses or PostgreSQL namespace scans.
type ResultWaiter = {
  notify: (result: StoredRelayResult) => void;
  fail: (error: unknown) => void;
};

export type StoredRelayResult = {
  seq: number;
  deliveryId: string;
  result?: JsonObject;
  resultSha256: string;
  idempotencyKey?: string;
  replayAuthority?: RelayDeliveryAuthority;
  recordedAt: string;
  consumedAt?: string;
};

type ResultStream = { deviceId: string; results: StoredRelayResult[] };
type ResultState = { version: 1; streams: ResultStream[] };

export class RelayResultStore {
  #file: string;
  #queue: Promise<void> = Promise.resolve();
  #clock: () => Date;
  #retentionMs: number;
  #shared?: ControlPlaneStore;
  #sharedNamespace: string;
  #latencyRecorder?: PipelineLatencyRecorder;
  #traceResultCommits: boolean;
  #waiters = new Map<string, Set<ResultWaiter>>();
  #waiterCount = 0;
  #pollTimer?: ReturnType<typeof setInterval>;
  #pollInFlight = false;

  constructor(stateDir: string, options: { clock?: () => Date; retentionMs?: number; sharedStore?: ControlPlaneStore; sharedNamespace?: string; latencyRecorder?: PipelineLatencyRecorder; traceResultCommits?: boolean } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'relay-results.json');
    this.#clock = options.clock ?? (() => new Date());
    this.#retentionMs = boundedRetention(options.retentionMs);
    this.#shared = options.sharedStore;
    this.#sharedNamespace = validSharedNamespace(options.sharedNamespace === undefined
      ? 'relay-result-streams' : options.sharedNamespace);
    this.#latencyRecorder = options.latencyRecorder;
    this.#traceResultCommits = options.traceResultCommits === true;
  }

  async put(deviceIdInput: string, seqInput: number, deliveryIdInput: string, resultInput: JsonObject, idempotencyKeyInput?: string, replayAuthorityInput?: RelayDeliveryAuthority): Promise<{ result: StoredRelayResult; duplicate: boolean }> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const seq = validSeq(seqInput);
    const deliveryId = validUuid(deliveryIdInput, 'deliveryId');
    const idempotencyKey = idempotencyKeyInput === undefined ? undefined : validIdempotencyKey(idempotencyKeyInput);
    const replayAuthority = replayAuthorityInput === undefined ? undefined : safeReplayAuthority(replayAuthorityInput, deviceId);
    if (replayAuthority && !idempotencyKey) throw new OperatorError('RELAY_RESULT_AUTHORITY_INVALID', 'Replay authority requires an idempotency key.');
    const result = safeResult(resultInput);
    const resultSha256 = hashResult(result);
    // Commit measurement deliberately ends only after the storage write or
    // shared-store CAS resolves. ACK, notification and execution authority
    // are completely outside this optional instrumentation.
    const commit = () => this.#mutate((state) => {
      pruneExpired(state, this.#clock().getTime(), this.#retentionMs);
      let stream = state.streams.find((candidate) => candidate.deviceId === deviceId);
      if (!stream) {
        if (state.streams.length >= MAX_STREAMS) throw new OperatorError('RELAY_RESULT_STREAM_LIMIT', 'Relay result stream limit reached.');
        stream = { deviceId, results: [] };
        state.streams.push(stream);
        state.streams.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
      }
      const existing = stream.results.find((entry) => entry.seq === seq || entry.deliveryId === deliveryId);
      if (existing) {
        if (existing.seq !== seq || existing.deliveryId !== deliveryId || existing.resultSha256 !== resultSha256) {
          throw new OperatorError('RELAY_RESULT_CONFLICT', 'A different result is already stored for this delivery sequence or ID.');
        }
        if (idempotencyKey && existing.idempotencyKey && existing.idempotencyKey !== idempotencyKey) {
          throw new OperatorError('RELAY_RESULT_CONFLICT', 'Stored result replay authority does not match this delivery.');
        }
        if (replayAuthority && existing.replayAuthority && !sameReplayAuthority(existing.replayAuthority, replayAuthority)) {
          throw new OperatorError('RELAY_RESULT_CONFLICT', 'Stored result account authority does not match this delivery.');
        }
        if (idempotencyKey && !existing.idempotencyKey && !existing.consumedAt) existing.idempotencyKey = idempotencyKey;
        if (replayAuthority && !existing.replayAuthority && !existing.consumedAt) existing.replayAuthority = replayAuthority;
        return { result: clone(existing), duplicate: true };
      }
      if (stream.results.length >= MAX_RESULTS_PER_STREAM) throw new OperatorError('RELAY_RESULT_LIMIT', 'Relay result retention limit reached for this device.');
      const stored: StoredRelayResult = { seq, deliveryId, result, resultSha256, idempotencyKey, replayAuthority, recordedAt: this.#clock().toISOString() };
      stream.results.push(stored);
      stream.results.sort((a, b) => a.seq - b.seq);
      return { result: clone(stored), duplicate: false };
    });
    const stored = this.#traceResultCommits && this.#latencyRecorder?.enabled
      ? await this.#latencyRecorder.measure({
          stage: 'relay.result_commit', origin: 'relay-server',
          traceId: deviceId + ':' + seq + ':' + deliveryId
        }, commit)
      : await commit();
    this.#notify(deviceId, seq, stored.result);
    return stored;
  }

  async get(deviceIdInput: string, seqInput: number): Promise<StoredRelayResult | null> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const seq = validSeq(seqInput);
    const state = await this.#read();
    const result = state.streams.find((stream) => stream.deviceId === deviceId)?.results.find((entry) => entry.seq === seq);
    if (!result || result.consumedAt || isExpired(result, this.#clock().getTime(), this.#retentionMs)) return null;
    return clone(result);
  }

  async waitFor(deviceIdInput: string, seqInput: number, deliveryIdInput: string, timeoutMsInput: number, signal?: AbortSignal): Promise<StoredRelayResult | null> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const seq = validSeq(seqInput);
    const deliveryId = validUuid(deliveryIdInput, 'deliveryId');
    const timeoutMs = typeof timeoutMsInput === 'number' ? timeoutMsInput : Number.NaN;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 10 * 60_000) {
      throw new OperatorError('RELAY_RESULT_WAIT_INVALID', 'Relay result wait must be between 0 and 600000 ms.');
    }
    if (signal?.aborted) return null;
    if (this.#waiterCount >= MAX_WAITERS) throw new OperatorError('RELAY_RESULT_WAITER_LIMIT', 'Relay result waiter limit reached.', { retryable: true });
    const key = `${deviceId}:${seq}`;
    const awaitResult = () => new Promise<StoredRelayResult | null>((resolve, reject) => {
      let settled = false;
      const finish = (result: StoredRelayResult | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        const listeners = this.#waiters.get(key);
        if (listeners?.delete(waiter)) this.#waiterCount--;
        if (listeners?.size === 0) this.#waiters.delete(key);
        this.#stopPollingIfIdle();
        resolve(result?.deliveryId === deliveryId ? clone(result) : null);
      };
      const failed = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        const listeners = this.#waiters.get(key);
        if (listeners?.delete(waiter)) this.#waiterCount--;
        if (listeners?.size === 0) this.#waiters.delete(key);
        this.#stopPollingIfIdle();
        reject(error);
      };
      const waiter: ResultWaiter = { notify: finish, fail: failed };
      const aborted = () => finish(null);
      const listeners = this.#waiters.get(key) ?? new Set<ResultWaiter>();
      listeners.add(waiter);
      this.#waiters.set(key, listeners);
      this.#waiterCount++;
      const timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref();
      signal?.addEventListener('abort', aborted, { once: true });
      // Register before starting the shared poll to avoid missed writes.
      if (signal?.aborted) return aborted();
      this.#startPolling();
    });
    // Explicitly injected telemetry only. With no recorder configured, keep
    // the exact original wait semantics and avoid trace-ID computation.
    if (!this.#latencyRecorder || !this.#latencyRecorder.enabled) return await awaitResult();
    // The per-process HMAC never exposes raw device/action/delivery identity,
    // and the recorder cannot affect result commit, identity or ACK authority.
    return await this.#latencyRecorder.measure({
      stage: 'relay.result_wait', origin: 'relay-server',
      traceId: deviceId + ':' + seq + ':' + deliveryId
    }, awaitResult, value => value !== null);
  }

  async findByIdempotencyKey(idempotencyKeyInput: string): Promise<{ deviceId: string; result: StoredRelayResult } | null> {
    const idempotencyKey = validIdempotencyKey(idempotencyKeyInput);
    return await this.#mutate((state) => {
      pruneExpired(state, this.#clock().getTime(), this.#retentionMs);
      let found: { deviceId: string; result: StoredRelayResult } | null = null;
      for (const stream of state.streams) {
        const match = stream.results.find((entry) => !entry.consumedAt && entry.idempotencyKey === idempotencyKey);
        if (!match) continue;
        if (found) throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Relay result replay authority is duplicated.');
        found = { deviceId: stream.deviceId, result: clone(match) };
      }
      return found;
    });
  }

  async consume(deviceIdInput: string, seqInput: number, deliveryIdInput: string): Promise<StoredRelayResult | null> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const seq = validSeq(seqInput);
    const deliveryId = validUuid(deliveryIdInput, 'deliveryId');
    return await this.#mutate((state) => {
      pruneExpired(state, this.#clock().getTime(), this.#retentionMs);
      const entry = state.streams.find((stream) => stream.deviceId === deviceId)?.results.find((candidate) => candidate.seq === seq);
      if (!entry || entry.consumedAt) return null;
      if (entry.deliveryId !== deliveryId) throw new OperatorError('RELAY_RESULT_DELIVERY_MISMATCH', 'Stored result does not match the requested delivery ID.');
      if (!entry.result) throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Available relay result is missing its payload.');
      const consumed = clone(entry);
      entry.result = undefined;
      entry.idempotencyKey = undefined;
      entry.replayAuthority = undefined;
      entry.consumedAt = this.#clock().toISOString();
      return consumed;
    });
  }

  async removeExact(deviceIdInput: string, seqInput: number, deliveryIdInput: string): Promise<boolean> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const seq = validSeq(seqInput);
    const deliveryId = validUuid(deliveryIdInput, 'deliveryId');
    return await this.#mutate((state) => {
      const stream = state.streams.find((item) => item.deviceId === deviceId);
      if (!stream) return false;
      const before = stream.results.length;
      stream.results = stream.results.filter((entry) => !(entry.seq === seq && entry.deliveryId === deliveryId));
      if (stream.results.length === 0) state.streams = state.streams.filter((item) => item !== stream);
      return stream.results.length !== before;
    });
  }

  async pruneExpired(): Promise<number> {
    return await this.#mutate((state) => pruneExpired(state, this.#clock().getTime(), this.#retentionMs));
  }

  async has(deviceIdInput: string, seqInput: number, deliveryIdInput: string): Promise<boolean> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const seq = validSeq(seqInput);
    const deliveryId = validUuid(deliveryIdInput, 'deliveryId');
    const result = await this.get(deviceId, seq);
    return Boolean(result && result.deliveryId === deliveryId);
  }

  async purgeDevice(deviceIdInput: string): Promise<number> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    return await this.#mutate((state) => {
      const stream = state.streams.find((item) => item.deviceId === deviceId);
      if (!stream) return 0;
      const removed = stream.results.length;
      state.streams = state.streams.filter((item) => item.deviceId !== deviceId);
      return removed;
    });
  }

  async #read(): Promise<ResultState> {
    if (this.#shared) return (await this.#readShared()).state;
    try {
      const text = await readDurableStateText(this.#file, {
        maxBytes: 256 * 1024 * 1024,
        errorCode: 'RELAY_RESULT_STATE_CORRUPT',
        invalidMessage: 'Relay result state is invalid.'
      });
      return validateState(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, streams: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Relay result state could not be read.');
    }
  }

  async #write(stateInput: ResultState): Promise<void> {
    if (this.#shared) throw new OperatorError('RELAY_RESULT_SHARED_WRITE_INVALID', 'Shared relay result state must commit through compare-and-swap mutation.');
    const state = validateState(stateInput);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), {
      maxBytes: 256 * 1024 * 1024,
      errorCode: 'RELAY_RESULT_STATE_CORRUPT',
      invalidMessage: 'Relay result state is invalid.'
    });
  }

  async #mutate<T>(mutator: (state: ResultState) => T | Promise<T>): Promise<T> {
    if (this.#shared) return await this.#mutateShared(mutator);
    let release!: () => void;
    const previous = this.#queue;
    this.#queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await withDurableStateLock(this.#file, async () => {
        const state = await this.#read();
        const value = await mutator(state);
        await this.#write(state);
        return value;
      });
    } finally {
      release();
    }
  }

  #notify(deviceId: string, seq: number, result: StoredRelayResult): void {
    for (const waiter of [...(this.#waiters.get(`${deviceId}:${seq}`) ?? [])]) waiter.notify(result);
  }

  #startPolling(): void {
    if (!this.#pollTimer) {
      this.#pollTimer = setInterval(() => { void this.#pollWaiters(); }, WAIT_FALLBACK_POLL_MS);
      this.#pollTimer.unref();
    }
    // One immediate read closes the registration/read race. If a read is
    // already in flight, the newly registered waiter joins the next tick.
    void this.#pollWaiters();
  }

  #stopPollingIfIdle(): void {
    if (this.#waiterCount !== 0 || !this.#pollTimer) return;
    clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
  }

  async #pollWaiters(): Promise<void> {
    if (this.#pollInFlight || this.#waiterCount === 0) return;
    this.#pollInFlight = true;
    try {
      // One validated durable snapshot serves every waiter, including writes
      // from another process or shared-store host. Never cache this snapshot
      // across polling cycles, and never notify from an uncommitted mutation.
      const state = await this.#read();
      const now = this.#clock().getTime();
      for (const stream of state.streams) {
        for (const result of stream.results) {
          if (result.consumedAt || isExpired(result, now, this.#retentionMs)) continue;
          if (this.#waiters.has(`${stream.deviceId}:${result.seq}`)) {
            this.#notify(stream.deviceId, result.seq, result);
          }
        }
      }
    } catch (error) {
      // Persisted corruption or a broken shared backend cannot silently turn
      // into a timeout. Each waiter receives the read failure and cleans up.
      for (const listeners of [...this.#waiters.values()]) {
        for (const waiter of [...listeners]) waiter.fail(error);
      }
    } finally {
      this.#pollInFlight = false;
    }
  }

  async #readShared(): Promise<{
    state: ResultState;
    generations: Map<string, number>;
    epochGeneration: number | null;
    epochCounter: number;
  }> {
    const records = await this.#shared!.list(this.#sharedNamespace);
    const streams: ResultStream[] = [];
    const generations = new Map<string, number>();
    let epochGeneration: number | null = null;
    let epochCounter = 0;
    for (const record of records) {
      if (record.key === '__epoch') {
        epochGeneration = record.generation;
        const counter = record.value.counter;
        // A persisted epoch is a typed monotonic counter; never normalize missing or coerced values.
        if (typeof counter !== 'number' || !Number.isSafeInteger(counter) || counter < 0) throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Shared relay result epoch is invalid.');
        epochCounter = counter;
        continue;
      }
      const stream = record.value.stream;
      // A shared CAS key is the authenticated storage identity for exactly one device.
      // Never let persisted data relabel a stream as another device or downgrade its schema.
      if (record.value.stateVersion !== 1 || !stream || typeof stream !== 'object' || Array.isArray(stream) ||
          (stream as Record<string, unknown>).deviceId !== record.key) {
        throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Shared relay result stream schema or device key is invalid.');
      }
      streams.push(structuredClone(stream) as ResultStream);
      generations.set(record.key, record.generation);
    }
    return {
      state: validateState({ version: 1, streams }),
      generations,
      epochGeneration,
      epochCounter
    };
  }

  async #mutateShared<T>(mutator: (state: ResultState) => T | Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const snapshot = await this.#readShared();
      const before = new Map(snapshot.state.streams.map((stream) => [stream.deviceId, JSON.stringify(stream)]));
      const value = await mutator(snapshot.state);
      const normalized = validateState(snapshot.state);
      const after = new Map(normalized.streams.map((stream) => [stream.deviceId, stream]));
      const keys = new Set([...before.keys(), ...after.keys()]);
      const mutations = [];
      for (const key of [...keys].sort()) {
        const prior = before.get(key);
        const next = after.get(key);
        if (prior !== undefined && next !== undefined && prior === JSON.stringify(next)) continue;
        if (next === undefined) {
          const generation = snapshot.generations.get(key);
          if (generation === undefined) continue;
          mutations.push({ namespace: this.#sharedNamespace, key, expectedGeneration: generation, value: null });
          continue;
        }
        const generation = snapshot.generations.get(key);
        mutations.push({
          namespace: this.#sharedNamespace,
          key,
          expectedGeneration: generation ?? null,
          value: { stateVersion: 1, stream: structuredClone(next) }
        });
      }
      if (mutations.length === 0) return value;
      mutations.push({
        namespace: this.#sharedNamespace,
        key: '__epoch',
        expectedGeneration: snapshot.epochGeneration,
        value: { counter: snapshot.epochCounter + 1 }
      });
      try {
        await this.#shared!.transact(mutations, this.#clock().toISOString());
        return value;
      } catch (error) {
        if (error instanceof OperatorError && error.code === 'CONTROL_PLANE_CAS_MISMATCH') continue;
        throw error;
      }
    }
    throw new OperatorError('RELAY_RESULT_CONTENTION', 'Shared relay result state remained contended after bounded retries.', { retryable: true });
  }
}

function validSharedNamespace(value: unknown): string {
  // A shared-state namespace is an authority boundary. Never invoke
  // attacker valueOf/toString hooks or accept coercible arrays/objects.
  if (typeof value !== 'string' ||
      !/^[A-Za-z0-9._:@/+=-]{1,256}$/.test(value) || value === '__epoch') {
    throw new OperatorError('RELAY_RESULT_SHARED_NAMESPACE_INVALID', 'Shared relay result namespace is invalid.');
  }
  return value;
}

function boundedRetention(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RETENTION_MS;
  if (!Number.isFinite(value) || value < 60_000 || value > MAX_RETENTION_MS) {
    throw new OperatorError('RELAY_RESULT_RETENTION_INVALID', `Relay result retention must be between 60000 and ${MAX_RETENTION_MS} ms.`);
  }
  return Math.trunc(value);
}

function isExpired(result: StoredRelayResult, now: number, retentionMs: number): boolean {
  // Unacknowledged results are replay-safety evidence. Expiring one would let
  // a reconnect execute the original mutation again after its local receipt
  // disappeared. Never TTL-prune an unconsumed result: the per-device result
  // cap and bounded file size fail closed instead of silently permitting replay.
  // Once consumed, the sensitive payload is already redacted and its minimal
  // tombstone can expire relative to consumption, not the original execution.
  return result.consumedAt !== undefined && Date.parse(result.consumedAt) <= now - retentionMs;
}

function pruneExpired(state: ResultState, now: number, retentionMs: number): number {
  let removed = 0;
  for (const stream of state.streams) {
    const kept = stream.results.filter((entry) => !isExpired(entry, now, retentionMs));
    removed += stream.results.length - kept.length;
    stream.results = kept;
  }
  state.streams = state.streams.filter((stream) => stream.results.length > 0);
  return removed;
}

function safeResult(input: unknown): JsonObject {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('RELAY_RESULT_INVALID', 'Relay result must be a JSON object.');
  let text: string;
  try { text = JSON.stringify(input); } catch { throw new OperatorError('RELAY_RESULT_INVALID', 'Relay result is not JSON serializable.'); }
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) throw new OperatorError('RELAY_RESULT_TOO_LARGE', 'Relay result exceeds the bounded size.');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new OperatorError('RELAY_RESULT_INVALID', 'Relay result must remain a JSON object after serialization.');
  return parsed as JsonObject;
}

function hashResult(result: JsonObject): string {
  return crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex');
}

function validateState(input: ResultState): ResultState {
  if (!input || typeof input !== 'object' || input.version !== 1 || !Array.isArray(input.streams) || input.streams.length > MAX_STREAMS) throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Relay result state structure is invalid.');
  const devices = new Set<string>();
  const replayKeys = new Set<string>();
  const streams = input.streams.map((raw) => {
    const deviceId = validUuid(raw.deviceId, 'deviceId');
    if (devices.has(deviceId)) throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Relay result state contains duplicate device streams.');
    devices.add(deviceId);
    if (!Array.isArray(raw.results) || raw.results.length > MAX_RESULTS_PER_STREAM) throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Relay result stream exceeds the retention limit.');
    const seqs = new Set<number>();
    const ids = new Set<string>();
    const results = raw.results.map((entry) => {
      const seq = validSeq(entry.seq);
      const deliveryId = validUuid(entry.deliveryId, 'deliveryId');
      if (seqs.has(seq) || ids.has(deliveryId)) throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Relay result state contains duplicate sequence or delivery ID.');
      seqs.add(seq); ids.add(deliveryId);
      const resultSha256 = entry.resultSha256;
      if (typeof resultSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(resultSha256)) throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Relay result hash is invalid.');
      const idempotencyKey = entry.idempotencyKey === undefined ? undefined : validIdempotencyKey(entry.idempotencyKey);
      const replayAuthority = entry.replayAuthority === undefined ? undefined : safeReplayAuthority(entry.replayAuthority, deviceId);
      if (replayAuthority && !idempotencyKey) throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Relay replay authority requires an idempotency key.');
      if (idempotencyKey) {
        if (replayKeys.has(idempotencyKey)) throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Relay result state contains duplicate replay authority.');
        replayKeys.add(idempotencyKey);
      }
      const recordedAt = validIso(entry.recordedAt);
      const consumedAt = entry.consumedAt === undefined ? undefined : validIso(entry.consumedAt);
      let result: JsonObject | undefined;
      if (consumedAt) {
        if (entry.result !== undefined || idempotencyKey || replayAuthority) throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Consumed relay result must not retain payload or replay authority.');
      } else {
        try { result = safeResult(entry.result); }
        catch { throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Available relay result payload is invalid.'); }
        if (resultSha256 !== hashResult(result)) throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Relay result hash does not match its stored result.');
      }
      return { seq, deliveryId, result, resultSha256, idempotencyKey, replayAuthority, recordedAt, consumedAt } satisfies StoredRelayResult;
    }).sort((a, b) => a.seq - b.seq);
    return { deviceId, results };
  });
  return { version: 1, streams };
}

function clone(result: StoredRelayResult): StoredRelayResult {
  return { ...result, result: result.result === undefined ? undefined : structuredClone(result.result), replayAuthority: result.replayAuthority ? { ...result.replayAuthority } : undefined };
}

function safeReplayAuthority(input: unknown, expectedDeviceId: string): RelayDeliveryAuthority {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('RELAY_RESULT_AUTHORITY_INVALID', 'Relay result replay authority is invalid.');
  const raw = input as Record<string, unknown>;
  const accountId = validUuid(raw.accountId, 'authority accountId');
  const deviceId = validUuid(raw.deviceId, 'authority deviceId');
  // Persisted replay authority must retain the original numeric generation.
  const generation = raw.generation;
  if (deviceId !== expectedDeviceId || typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) throw new OperatorError('RELAY_RESULT_AUTHORITY_INVALID', 'Relay result replay authority is invalid.');
  return { accountId, deviceId, generation };
}

function sameReplayAuthority(a: RelayDeliveryAuthority, b: RelayDeliveryAuthority): boolean {
  return a.accountId === b.accountId && a.deviceId === b.deviceId && a.generation === b.generation;
}

function validIdempotencyKey(input: unknown): string {
  if (typeof input !== 'string') throw new OperatorError('RELAY_IDEMPOTENCY_INVALID', 'Relay idempotency key is invalid.');
  const value = input.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new OperatorError('RELAY_IDEMPOTENCY_INVALID', 'Relay idempotency key is invalid.');
  return value;
}

function validSeq(input: unknown): number {
  if (typeof input !== 'number') throw new OperatorError('RELAY_RESULT_SEQUENCE_INVALID', 'Relay result sequence must be a positive safe integer.');
  const seq = input;
  if (!Number.isSafeInteger(seq) || seq < 1) throw new OperatorError('RELAY_RESULT_SEQUENCE_INVALID', 'Relay result sequence must be a positive safe integer.');
  return seq;
}

function validUuid(input: unknown, label: string): string {
  if (typeof input !== 'string') throw new OperatorError('RELAY_RESULT_ID_INVALID', `${label} must be a UUID.`);
  const value = input;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new OperatorError('RELAY_RESULT_ID_INVALID', `${label} must be a UUID.`);
  return value.toLowerCase();
}

function validIso(input: unknown): string {
  if (typeof input !== 'string') throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Relay result timestamp must be ISO format.');
  const time = Date.parse(input);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== input) throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Relay result timestamp must be ISO format.');
  return input;
}
