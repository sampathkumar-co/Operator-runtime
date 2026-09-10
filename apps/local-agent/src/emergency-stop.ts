import path from 'node:path';
import { OperatorError } from '../../../src/core/errors.ts';
import { readDurableStateText, writeDurableStateText } from '../../../src/core/durable-state.ts';

const MAX_REASON = 512;
const EMERGENCY_STOP_OPTIONS = {
  maxBytes: 16 * 1024,
  errorCode: 'EMERGENCY_STOP_STATE_INVALID',
  invalidMessage: 'Emergency stop state is invalid.'
} as const;

type EmergencyStopState = {
  version: 1;
  engaged: boolean;
  engagedAt?: string;
  reason?: string;
  clearedAt?: string;
};

export class EmergencyStopStore {
  #file: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.#file = path.join(path.resolve(stateDir), 'emergency-stop.json');
  }

  async status(): Promise<Readonly<EmergencyStopState>> {
    return await this.#read();
  }

  async engage(reasonInput?: string): Promise<Readonly<EmergencyStopState>> {
    const reason = reasonInput === undefined ? undefined : validReason(reasonInput);
    return await this.#mutate((current) => {
      if (current.engaged) return current;
      return {
        version: 1,
        engaged: true,
        engagedAt: new Date().toISOString(),
        reason
      };
    });
  }

  async clear(): Promise<Readonly<EmergencyStopState>> {
    return await this.#mutate(() => ({
      version: 1,
      engaged: false,
      clearedAt: new Date().toISOString()
    }));
  }

  async #read(): Promise<EmergencyStopState> {
    let raw: string;
    try {
      raw = await readDurableStateText(this.#file, EMERGENCY_STOP_OPTIONS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, engaged: false };
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalidState('Stored emergency stop state is not valid JSON.');
    }
    return validateState(parsed);
  }

  async #write(stateInput: EmergencyStopState): Promise<void> {
    const state = validateState(stateInput);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), EMERGENCY_STOP_OPTIONS);
  }

  async #mutate(mutator: (state: EmergencyStopState) => EmergencyStopState): Promise<EmergencyStopState> {
    let release!: () => void;
    const previous = this.#queue;
    this.#queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const next = mutator(await this.#read());
      await this.#write(next);
      return next;
    } finally {
      release();
    }
  }
}

function validReason(value: string): string {
  if (typeof value !== 'string') throw invalidState('Emergency stop reason is invalid.');
  const reason = value.trim();
  if (!reason || reason.length > MAX_REASON || /\0/.test(reason)) throw invalidState('Emergency stop reason is invalid.');
  return reason;
}

function validateState(input: unknown): EmergencyStopState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidState('Emergency stop state structure is invalid.');
  }
  const raw = input as Record<string, unknown>;
  const allowed = new Set(['version', 'engaged', 'engagedAt', 'reason', 'clearedAt']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw invalidState('Emergency stop state contains unsupported fields.');
  }
  if (raw.version !== 1 || typeof raw.engaged !== 'boolean') {
    throw invalidState('Emergency stop state structure is invalid.');
  }

  const engagedAt = raw.engagedAt === undefined ? undefined : strictIso(raw.engagedAt, 'engagedAt');
  const clearedAt = raw.clearedAt === undefined ? undefined : strictIso(raw.clearedAt, 'clearedAt');
  const reason = raw.reason === undefined ? undefined : strictReason(raw.reason);

  if (raw.engaged) {
    if (!engagedAt) throw invalidState('Engaged emergency stop requires engagedAt.');
    if (clearedAt) throw invalidState('Engaged emergency stop cannot retain clearedAt.');
  } else if (engagedAt || reason) {
    throw invalidState('Cleared emergency stop cannot retain engagement metadata.');
  }

  return { version: 1, engaged: raw.engaged, engagedAt, reason, clearedAt };
}

function strictReason(value: unknown): string {
  if (typeof value !== 'string') throw invalidState('Emergency stop reason must be a string.');
  return validReason(value);
}

function strictIso(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalidState(`Emergency stop ${field} must be a string timestamp.`);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw invalidState(`Emergency stop ${field} timestamp is invalid.`);
  }
  return value;
}

function invalidState(message: string): OperatorError {
  return new OperatorError('EMERGENCY_STOP_STATE_INVALID', message);
}
