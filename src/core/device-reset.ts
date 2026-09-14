import path from 'node:path';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

const MAX_RECORDS = 4096;
const RETENTION_MS = 24 * 60 * 60_000;
const MAX_STATE_BYTES = 2 * 1024 * 1024;

type Clock = () => Date;

export interface DeviceResetRecord {
  sessionJti: string;
  deviceId: string;
  accountId: string;
  authorityGeneration: number;
  phase: 'REQUESTED' | 'COMPLETE';
  requestedAt: string;
  updatedAt: string;
  completedAt?: string;
}

type ResetState = { version: 1; records: DeviceResetRecord[] };

export class DeviceResetStore {
  #file: string;
  #clock: Clock;
  #queue: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: { clock?: Clock } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'device-resets.json');
    this.#clock = options.clock ?? (() => new Date());
  }

  async get(sessionJtiInput: string): Promise<DeviceResetRecord | null> {
    const sessionJti = validUuid(sessionJtiInput, 'sessionJti');
    const state = await this.#read();
    const record = state.records.find((candidate) => candidate.sessionJti === sessionJti);
    return record ? clone(record) : null;
  }

  async begin(input: {
    sessionJti: string;
    deviceId: string;
    accountId: string;
    authorityGeneration: number;
  }): Promise<DeviceResetRecord> {
    const sessionJti = validUuid(input.sessionJti, 'sessionJti');
    const deviceId = validUuid(input.deviceId, 'deviceId');
    const accountId = validUuid(input.accountId, 'accountId');
    const authorityGeneration = validGeneration(input.authorityGeneration);
    return await this.#mutate((state) => {
      const now = this.#clock();
      prune(state, now.getTime());
      const existing = state.records.find((candidate) => candidate.sessionJti === sessionJti);
      if (existing) {
        if (existing.deviceId !== deviceId || existing.accountId !== accountId || existing.authorityGeneration !== authorityGeneration) {
          throw new OperatorError('DEVICE_RESET_STATE_MISMATCH', 'Device reset authority no longer matches the recorded reset request.');
        }
        return clone(existing);
      }
      if (state.records.length >= MAX_RECORDS) throw new OperatorError('DEVICE_RESET_LIMIT', `At most ${MAX_RECORDS} device reset records may be retained.`);
      const created: DeviceResetRecord = {
        sessionJti, deviceId, accountId, authorityGeneration,
        phase: 'REQUESTED', requestedAt: now.toISOString(), updatedAt: now.toISOString()
      };
      state.records.push(created);
      return clone(created);
    });
  }

  async complete(sessionJtiInput: string): Promise<DeviceResetRecord> {
    const sessionJti = validUuid(sessionJtiInput, 'sessionJti');
    return await this.#mutate((state) => {
      const record = state.records.find((candidate) => candidate.sessionJti === sessionJti);
      if (!record) throw new OperatorError('DEVICE_RESET_NOT_FOUND', 'Device reset request was not found.');
      if (record.phase === 'COMPLETE') return clone(record);
      const now = this.#clock().toISOString();
      record.phase = 'COMPLETE';
      record.updatedAt = now;
      record.completedAt = now;
      return clone(record);
    });
  }

  async #read(): Promise<ResetState> {
    try {
      const text = await readDurableStateText(this.#file, {
        maxBytes: MAX_STATE_BYTES,
        errorCode: 'DEVICE_RESET_STATE_CORRUPT',
        invalidMessage: 'Device reset state is invalid.'
      });
      return validateState(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('DEVICE_RESET_STATE_CORRUPT', 'Device reset state could not be read.');
    }
  }
  async #write(stateInput: ResetState): Promise<void> {
    const state = validateState(stateInput);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), {
      maxBytes: MAX_STATE_BYTES,
      errorCode: 'DEVICE_RESET_STATE_CORRUPT',
      invalidMessage: 'Device reset state is invalid.'
    });
  }

  async #mutate<T>(mutator: (state: ResetState) => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.#queue;
    this.#queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const state = await this.#read();
      const result = await mutator(state);
      await this.#write(state);
      return result;
    } finally {
      release();
    }
  }
}

function validateState(input: ResetState): ResetState {
  if (!input || typeof input !== 'object' || input.version !== 1 || !Array.isArray(input.records) || input.records.length > MAX_RECORDS) {
    throw new OperatorError('DEVICE_RESET_STATE_CORRUPT', 'Device reset state structure is invalid.');
  }
  const seen = new Set<string>();
  const records = input.records.map((raw) => {
    const sessionJti = validUuid(String(raw.sessionJti ?? ''), 'sessionJti');
    if (seen.has(sessionJti)) throw new OperatorError('DEVICE_RESET_STATE_CORRUPT', 'Device reset state contains duplicate session IDs.');
    seen.add(sessionJti);
    const deviceId = validUuid(String(raw.deviceId ?? ''), 'deviceId');
    const accountId = validUuid(String(raw.accountId ?? ''), 'accountId');
    const authorityGeneration = validGeneration(Number(raw.authorityGeneration));
    const phase = raw.phase === 'REQUESTED' ? 'REQUESTED' : raw.phase === 'COMPLETE' ? 'COMPLETE' : null;
    if (!phase) throw new OperatorError('DEVICE_RESET_STATE_CORRUPT', 'Device reset phase is invalid.');
    const requestedAt = validIso(String(raw.requestedAt ?? ''), 'requestedAt');
    const updatedAt = validIso(String(raw.updatedAt ?? ''), 'updatedAt');
    const completedAt = raw.completedAt === undefined ? undefined : validIso(String(raw.completedAt), 'completedAt');
    if (phase === 'REQUESTED' && completedAt) throw new OperatorError('DEVICE_RESET_STATE_CORRUPT', 'Pending device reset cannot have a completion timestamp.');
    if (phase === 'COMPLETE' && !completedAt) throw new OperatorError('DEVICE_RESET_STATE_CORRUPT', 'Completed device reset must have a completion timestamp.');
    if (Date.parse(updatedAt) < Date.parse(requestedAt) || (completedAt && Date.parse(completedAt) < Date.parse(requestedAt))) {
      throw new OperatorError('DEVICE_RESET_STATE_CORRUPT', 'Device reset timestamps are inconsistent.');
    }
    return { sessionJti, deviceId, accountId, authorityGeneration, phase, requestedAt, updatedAt, completedAt } satisfies DeviceResetRecord;
  });
  return { version: 1, records };
}
function prune(state: ResetState, nowMs: number): void {
  state.records = state.records.filter((record) => record.phase !== 'COMPLETE' || nowMs - Date.parse(record.completedAt!) <= RETENTION_MS);
}

function clone(record: DeviceResetRecord): DeviceResetRecord {
  return { ...record };
}

function validGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new OperatorError('DEVICE_RESET_STATE_CORRUPT', 'Device reset authority generation is invalid.');
  }
  return value;
}

function validUuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new OperatorError('DEVICE_RESET_STATE_CORRUPT', `${label} must be a UUID.`);
  }
  return value.toLowerCase();
}

function validIso(value: string, label: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new OperatorError('DEVICE_RESET_STATE_CORRUPT', `${label} must be an ISO timestamp.`);
  }
  return value;
}
