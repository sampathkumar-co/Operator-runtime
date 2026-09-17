import crypto from 'node:crypto';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import type { RelayDeliveryAuthority } from './relay-delivery-store.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

const MAX_STREAMS = 10_000;
const MAX_RESULTS_PER_STREAM = 10_000;
const MAX_RESULT_BYTES = 256 * 1024;
const DEFAULT_RETENTION_MS = 24 * 60 * 60_000;
const MAX_RETENTION_MS = 30 * 24 * 60 * 60_000;

type JsonObject = Record<string, unknown>;

type StoredRelayResult = {
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

  constructor(stateDir: string, options: { clock?: () => Date; retentionMs?: number } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'relay-results.json');
    this.#clock = options.clock ?? (() => new Date());
    this.#retentionMs = boundedRetention(options.retentionMs);
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
    return await this.#mutate((state) => {
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
  }

  async get(deviceIdInput: string, seqInput: number): Promise<StoredRelayResult | null> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const seq = validSeq(seqInput);
    const state = await this.#read();
    const result = state.streams.find((stream) => stream.deviceId === deviceId)?.results.find((entry) => entry.seq === seq);
    if (!result || result.consumedAt || isExpired(result, this.#clock().getTime(), this.#retentionMs)) return null;
    return clone(result);
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
    const state = validateState(stateInput);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), {
      maxBytes: 256 * 1024 * 1024,
      errorCode: 'RELAY_RESULT_STATE_CORRUPT',
      invalidMessage: 'Relay result state is invalid.'
    });
  }

  async #mutate<T>(mutator: (state: ResultState) => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.#queue;
    this.#queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const state = await this.#read();
      const value = await mutator(state);
      await this.#write(state);
      return value;
    } finally {
      release();
    }
  }
}

function boundedRetention(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RETENTION_MS;
  if (!Number.isFinite(value) || value < 60_000 || value > MAX_RETENTION_MS) {
    throw new OperatorError('RELAY_RESULT_RETENTION_INVALID', `Relay result retention must be between 60000 and ${MAX_RETENTION_MS} ms.`);
  }
  return Math.trunc(value);
}

function isExpired(result: StoredRelayResult, now: number, retentionMs: number): boolean {
  return Date.parse(result.recordedAt) <= now - retentionMs;
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
      const resultSha256 = String(entry.resultSha256 ?? '');
      if (!/^[0-9a-f]{64}$/.test(resultSha256)) throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Relay result hash is invalid.');
      const idempotencyKey = entry.idempotencyKey === undefined ? undefined : validIdempotencyKey(String(entry.idempotencyKey));
      const replayAuthority = entry.replayAuthority === undefined ? undefined : safeReplayAuthority(entry.replayAuthority, deviceId);
      if (replayAuthority && !idempotencyKey) throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Relay replay authority requires an idempotency key.');
      if (idempotencyKey) {
        if (replayKeys.has(idempotencyKey)) throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Relay result state contains duplicate replay authority.');
        replayKeys.add(idempotencyKey);
      }
      const recordedAt = validIso(String(entry.recordedAt ?? ''));
      const consumedAt = entry.consumedAt === undefined ? undefined : validIso(String(entry.consumedAt));
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
  const accountId = validUuid(String(raw.accountId ?? ''), 'authority accountId');
  const deviceId = validUuid(String(raw.deviceId ?? ''), 'authority deviceId');
  const generation = Number(raw.generation);
  if (deviceId !== expectedDeviceId || !Number.isSafeInteger(generation) || generation < 1) throw new OperatorError('RELAY_RESULT_AUTHORITY_INVALID', 'Relay result replay authority is invalid.');
  return { accountId, deviceId, generation };
}

function sameReplayAuthority(a: RelayDeliveryAuthority, b: RelayDeliveryAuthority): boolean {
  return a.accountId === b.accountId && a.deviceId === b.deviceId && a.generation === b.generation;
}

function validIdempotencyKey(input: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new OperatorError('RELAY_IDEMPOTENCY_INVALID', 'Relay idempotency key is invalid.');
  return value;
}

function validSeq(input: number): number {
  const seq = Number(input);
  if (!Number.isSafeInteger(seq) || seq < 1) throw new OperatorError('RELAY_RESULT_SEQUENCE_INVALID', 'Relay result sequence must be a positive safe integer.');
  return seq;
}

function validUuid(input: string, label: string): string {
  const value = String(input ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new OperatorError('RELAY_RESULT_ID_INVALID', `${label} must be a UUID.`);
  return value.toLowerCase();
}

function validIso(input: string): string {
  const time = Date.parse(input);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== input) throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Relay result timestamp must be ISO format.');
  return input;
}
