import path from 'node:path';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

const MAX_ENTRIES = 512;
const MAX_COUNTER_TOTAL = 1000;
const MAX_ADJUSTMENT = 0.06;
const STATE_OPTIONS = {
  maxBytes: 512 * 1024,
  errorCode: 'PROVIDER_LEARNING_STATE_CORRUPT',
  invalidMessage: 'Provider learning state is invalid.'
} as const;

export interface ProviderLearning {
  adjustment(capability: string, provider: string): Promise<number>;
  record(capability: string, provider: string, outcome: 'verified' | 'failed'): Promise<void>;
}

type LearningEntry = {
  capability: string;
  provider: string;
  verified: number;
  failed: number;
  updatedAt: string;
};

type LearningState = {
  version: 1;
  entries: LearningEntry[];
};

export class ProviderLearningStore implements ProviderLearning {
  #file: string;
  #clock: () => Date;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: { clock?: () => Date } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'provider-learning.json');
    this.#clock = options.clock ?? (() => new Date());
  }

  async adjustment(capabilityInput: string, providerInput: string): Promise<number> {
    const capability = boundedKey(capabilityInput, 'capability');
    const provider = boundedKey(providerInput, 'provider');
    await this.#serial;
    const state = await this.#read();
    const entry = state.entries.find((item) => item.capability === capability && item.provider === provider);
    return entry ? learnedAdjustment(entry.verified, entry.failed) : 0;
  }

  async record(capabilityInput: string, providerInput: string, outcome: 'verified' | 'failed'): Promise<void> {
    const capability = boundedKey(capabilityInput, 'capability');
    const provider = boundedKey(providerInput, 'provider');
    if (outcome !== 'verified' && outcome !== 'failed') throw new OperatorError('PROVIDER_LEARNING_INPUT_INVALID', 'Provider learning outcome is invalid.');
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      let entry = state.entries.find((item) => item.capability === capability && item.provider === provider);
      if (!entry) {
        if (state.entries.length >= MAX_ENTRIES) {
          state.entries.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || entryKey(a).localeCompare(entryKey(b)));
          state.entries.shift();
        }
        entry = { capability, provider, verified: 0, failed: 0, updatedAt: this.#clock().toISOString() };
        state.entries.push(entry);
      }
      if (entry.verified + entry.failed >= MAX_COUNTER_TOTAL) {
        entry.verified = Math.floor(entry.verified / 2);
        entry.failed = Math.floor(entry.failed / 2);
      }
      if (outcome === 'verified') entry.verified += 1;
      else entry.failed += 1;
      entry.updatedAt = this.#clock().toISOString();
      state.entries.sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
      await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STATE_OPTIONS);
    });
    this.#serial = run.catch(() => undefined);
    return await run;
  }

  async #read(): Promise<LearningState> {
    let text: string;
    try {
      text = await readDurableStateText(this.#file, STATE_OPTIONS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: [] };
      throw error;
    }
    let decoded: unknown;
    try { decoded = JSON.parse(text); }
    catch { throw corrupt('State is not valid JSON.'); }
    return validateState(decoded);
  }
}

export function learnedAdjustment(verified: number, failed: number): number {
  const successes = boundedCount(verified);
  const failures = boundedCount(failed);
  const total = successes + failures;
  if (total < 2) return 0;
  const posteriorSuccess = (successes + 2) / (total + 4);
  const centered = (posteriorSuccess - 0.5) * 2;
  const confidence = Math.min(1, total / 20);
  return clamp(centered * confidence * MAX_ADJUSTMENT, -MAX_ADJUSTMENT, MAX_ADJUSTMENT);
}

function validateState(input: unknown): LearningState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('State must be an object.');
  const raw = input as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.entries) || raw.entries.length > MAX_ENTRIES) {
    throw corrupt(`State must contain at most ${MAX_ENTRIES} version-1 entries.`);
  }
  const seen = new Set<string>();
  const entries = raw.entries.map((value, index): LearningEntry => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt(`Entry ${index} must be an object.`);
    const item = value as Record<string, unknown>;
    const entry = {
      capability: boundedKey(item.capability, `entry ${index} capability`),
      provider: boundedKey(item.provider, `entry ${index} provider`),
      verified: boundedCount(item.verified),
      failed: boundedCount(item.failed),
      updatedAt: validIso(item.updatedAt, `entry ${index} updatedAt`)
    };
    const key = entryKey(entry);
    if (seen.has(key)) throw corrupt(`Entry ${index} duplicates a capability/provider pair.`);
    seen.add(key);
    return entry;
  });
  return { version: 1, entries };
}

function entryKey(entry: Pick<LearningEntry, 'capability' | 'provider'>): string {
  return `${entry.capability}\0${entry.provider}`;
}
function boundedKey(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > 256 || input.includes('\0') || /[\r\n]/.test(input)) {
    throw new OperatorError('PROVIDER_LEARNING_INPUT_INVALID', `${label} is invalid.`);
  }
  return input;
}
function boundedCount(input: unknown): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COUNTER_TOTAL) throw corrupt('Learning counters are invalid.');
  return value;
}
function validIso(input: unknown, label: string): string {
  const value = String(input ?? '');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw corrupt(`${label} must be an ISO timestamp.`);
  return value;
}
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
function corrupt(message: string): OperatorError {
  return new OperatorError('PROVIDER_LEARNING_STATE_CORRUPT', `Provider learning state is invalid. ${message}`);
}
