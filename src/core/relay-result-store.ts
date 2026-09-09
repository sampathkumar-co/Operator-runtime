import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OperatorError } from './errors.ts';

const MAX_STREAMS = 10_000;
const MAX_RESULTS_PER_STREAM = 10_000;
const MAX_RESULT_BYTES = 256 * 1024;

type JsonObject = Record<string, unknown>;

type StoredRelayResult = {
  seq: number;
  deliveryId: string;
  result: JsonObject;
  resultSha256: string;
  recordedAt: string;
};

type ResultStream = { deviceId: string; results: StoredRelayResult[] };
type ResultState = { version: 1; streams: ResultStream[] };

export class RelayResultStore {
  #file: string;
  #queue: Promise<void> = Promise.resolve();
  #clock: () => Date;

  constructor(stateDir: string, options: { clock?: () => Date } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'relay-results.json');
    this.#clock = options.clock ?? (() => new Date());
  }

  async put(deviceIdInput: string, seqInput: number, deliveryIdInput: string, resultInput: JsonObject): Promise<{ result: StoredRelayResult; duplicate: boolean }> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const seq = validSeq(seqInput);
    const deliveryId = validUuid(deliveryIdInput, 'deliveryId');
    const result = safeResult(resultInput);
    const resultSha256 = hashResult(result);
    return await this.#mutate((state) => {
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
        return { result: clone(existing), duplicate: true };
      }
      if (stream.results.length >= MAX_RESULTS_PER_STREAM) throw new OperatorError('RELAY_RESULT_LIMIT', 'Relay result retention limit reached for this device.');
      const stored: StoredRelayResult = { seq, deliveryId, result, resultSha256, recordedAt: this.#clock().toISOString() };
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
    return result ? clone(result) : null;
  }

  async has(deviceIdInput: string, seqInput: number, deliveryIdInput: string): Promise<boolean> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const seq = validSeq(seqInput);
    const deliveryId = validUuid(deliveryIdInput, 'deliveryId');
    const result = await this.get(deviceId, seq);
    return Boolean(result && result.deliveryId === deliveryId);
  }

  async #read(): Promise<ResultState> {
    try {
      const stat = await fs.stat(this.#file);
      if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Relay result state file is invalid.');
      return validateState(JSON.parse(await fs.readFile(this.#file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, streams: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Relay result state could not be read.');
    }
  }

  async #write(stateInput: ResultState): Promise<void> {
    const state = validateState(stateInput);
    await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const temp = `${this.#file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temp, this.#file);
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
      const result = safeResult(entry.result);
      const resultSha256 = String(entry.resultSha256 ?? '');
      if (!/^[0-9a-f]{64}$/.test(resultSha256) || resultSha256 !== hashResult(result)) throw new OperatorError('RELAY_RESULT_STATE_CORRUPT', 'Relay result hash does not match its stored result.');
      const recordedAt = validIso(String(entry.recordedAt ?? ''));
      return { seq, deliveryId, result, resultSha256, recordedAt } satisfies StoredRelayResult;
    }).sort((a, b) => a.seq - b.seq);
    return { deviceId, results };
  });
  return { version: 1, streams };
}

function clone(result: StoredRelayResult): StoredRelayResult {
  return { ...result, result: structuredClone(result.result) };
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
