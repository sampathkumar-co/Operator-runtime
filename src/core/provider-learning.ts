import path from 'node:path';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

const MAX_ENTRIES = 512;
const MAX_COUNTER_TOTAL = 1000;
const MAX_ADJUSTMENT = 0.06;
const MAX_RELIABILITY_ADJUSTMENT = 0.05;
const MAX_LATENCY_PENALTY = 0.01;
const MAX_LATENCY_MS = 60 * 60_000;
const STATE_OPTIONS = {
  maxBytes: 512 * 1024,
  errorCode: 'PROVIDER_LEARNING_STATE_CORRUPT',
  invalidMessage: 'Provider learning state is invalid.'
} as const;

export type ProviderLearningMetadata = {
  context?: string;
  durationMs?: number;
};

export interface ProviderLearning {
  adjustment(capability: string, provider: string, context?: string): Promise<number>;
  record(capability: string, provider: string, outcome: 'verified' | 'failed', metadata?: ProviderLearningMetadata): Promise<void>;
}

type LearningEntry = {
  capability: string;
  provider: string;
  context: string;
  verified: number;
  failed: number;
  latencyEwmaMs: number;
  latencySamples: number;
  updatedAt: string;
};

type LearningState = {
  version: 2;
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

  async adjustment(capabilityInput: string, providerInput: string, contextInput = 'global'): Promise<number> {
    const capability = boundedKey(capabilityInput, 'capability');
    const provider = boundedKey(providerInput, 'provider');
    const context = boundedContext(contextInput);
    await this.#serial;
    const state = await this.#read();
    const exact = state.entries.find((item) => item.capability === capability && item.provider === provider && item.context === context);
    const fallback = context === 'global'
      ? undefined
      : state.entries.find((item) => item.capability === capability && item.provider === provider && item.context === 'global');
    const entry = exact ?? fallback;
    return entry ? learnedAdjustment(entry.verified, entry.failed, entry.latencyEwmaMs, entry.latencySamples) : 0;
  }

  async record(
    capabilityInput: string,
    providerInput: string,
    outcome: 'verified' | 'failed',
    metadata: ProviderLearningMetadata = {}
  ): Promise<void> {
    const capability = boundedKey(capabilityInput, 'capability');
    const provider = boundedKey(providerInput, 'provider');
    const context = boundedContext(metadata.context ?? 'global');
    const durationMs = boundedDuration(metadata.durationMs);
    if (outcome !== 'verified' && outcome !== 'failed') throw new OperatorError('PROVIDER_LEARNING_INPUT_INVALID', 'Provider learning outcome is invalid.');

    const run = this.#serial.then(async () => {
      const state = await this.#read();
      let entry = state.entries.find((item) => item.capability === capability && item.provider === provider && item.context === context);
      if (!entry) {
        if (state.entries.length >= MAX_ENTRIES) {
          state.entries.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || entryKey(a).localeCompare(entryKey(b)));
          state.entries.shift();
        }
        entry = {
          capability, provider, context,
          verified: 0, failed: 0,
          latencyEwmaMs: 0, latencySamples: 0,
          updatedAt: this.#clock().toISOString()
        };
        state.entries.push(entry);
      }

      if (entry.verified + entry.failed >= MAX_COUNTER_TOTAL) {
        entry.verified = Math.floor(entry.verified / 2);
        entry.failed = Math.floor(entry.failed / 2);
      }
      if (outcome === 'verified') entry.verified += 1;
      else entry.failed += 1;

      if (durationMs !== undefined) {
        entry.latencyEwmaMs = entry.latencySamples === 0
          ? durationMs
          : Math.round((entry.latencyEwmaMs * 0.8 + durationMs * 0.2) * 1000) / 1000;
        entry.latencySamples = Math.min(MAX_COUNTER_TOTAL, entry.latencySamples + 1);
      }

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
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, entries: [] };
      throw error;
    }

    let decoded: unknown;
    try { decoded = JSON.parse(text); }
    catch { throw corrupt('State is not valid JSON.'); }
    return validateState(decoded);
  }
}

export function learnedAdjustment(verified: number, failed: number, latencyEwmaMs = 0, latencySamples = 0): number {
  const successes = boundedCount(verified);
  const failures = boundedCount(failed);
  const total = successes + failures;

  let reliabilityAdjustment = 0;
  if (total >= 2) {
    const posteriorSuccess = (successes + 2) / (total + 4);
    const centered = (posteriorSuccess - 0.5) * 2;
    const confidence = Math.min(1, total / 20);
    reliabilityAdjustment = centered * confidence * MAX_RELIABILITY_ADJUSTMENT;
  }

  const samples = boundedCount(latencySamples);
  const latency = boundedLatencyState(latencyEwmaMs);
  let latencyPenalty = 0;
  if (samples >= 3 && latency > 100) {
    const normalized = clamp((Math.log10(latency) - 2) / 3, 0, 1);
    latencyPenalty = normalized * MAX_LATENCY_PENALTY;
  }

  return clamp(reliabilityAdjustment - latencyPenalty, -MAX_ADJUSTMENT, MAX_ADJUSTMENT);
}

function validateState(input: unknown): LearningState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('State must be an object.');
  const raw = input as Record<string, unknown>;
  if (!Array.isArray(raw.entries) || raw.entries.length > MAX_ENTRIES) {
    throw corrupt(`State must contain at most ${MAX_ENTRIES} entries.`);
  }

  if (raw.version === 1) {
    const seen = new Set<string>();
    const entries = raw.entries.map((value, index): LearningEntry => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt(`Entry ${index} must be an object.`);
      const item = value as Record<string, unknown>;
      const entry: LearningEntry = {
        capability: storedKey(item.capability, `entry ${index} capability`),
        provider: storedKey(item.provider, `entry ${index} provider`),
        context: 'global',
        verified: boundedCount(item.verified),
        failed: boundedCount(item.failed),
        latencyEwmaMs: 0,
        latencySamples: 0,
        updatedAt: validIso(item.updatedAt, `entry ${index} updatedAt`)
      };
      const key = entryKey(entry);
      if (seen.has(key)) throw corrupt(`Entry ${index} duplicates a capability/provider/context tuple.`);
      seen.add(key);
      return entry;
    });
    return { version: 2, entries };
  }

  if (raw.version !== 2) throw corrupt('State version must be 1 or 2.');
  const seen = new Set<string>();
  const entries = raw.entries.map((value, index): LearningEntry => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt(`Entry ${index} must be an object.`);
    const item = value as Record<string, unknown>;
    const entry: LearningEntry = {
      capability: storedKey(item.capability, `entry ${index} capability`),
      provider: storedKey(item.provider, `entry ${index} provider`),
      context: storedContext(item.context, `entry ${index} context`),
      verified: boundedCount(item.verified),
      failed: boundedCount(item.failed),
      latencyEwmaMs: boundedLatencyState(item.latencyEwmaMs),
      latencySamples: boundedCount(item.latencySamples),
      updatedAt: validIso(item.updatedAt, `entry ${index} updatedAt`)
    };
    const key = entryKey(entry);
    if (seen.has(key)) throw corrupt(`Entry ${index} duplicates a capability/provider/context tuple.`);
    seen.add(key);
    return entry;
  });
  return { version: 2, entries };
}

function entryKey(entry: Pick<LearningEntry, 'capability' | 'provider' | 'context'>): string {
  return `${entry.capability}\0${entry.provider}\0${entry.context}`;
}

function storedKey(input: unknown, label: string): string {
  try { return boundedKey(input, label); }
  catch { throw corrupt(`${label} is invalid.`); }
}

function storedContext(input: unknown, label: string): string {
  try { return boundedContext(input); }
  catch { throw corrupt(`${label} is invalid.`); }
}

function boundedKey(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > 256 || input.includes('\0') || /[\r\n]/.test(input)) {
    throw new OperatorError('PROVIDER_LEARNING_INPUT_INVALID', `${label} is invalid.`);
  }
  return input;
}

function boundedContext(input: unknown): string {
  const value = String(input ?? 'global');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new OperatorError('PROVIDER_LEARNING_INPUT_INVALID', 'learning context is invalid.');
  }
  return value;
}

function boundedDuration(input: unknown): number | undefined {
  if (input === undefined) return undefined;
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0 || value > MAX_LATENCY_MS) {
    throw new OperatorError('PROVIDER_LEARNING_INPUT_INVALID', 'learning duration is invalid.');
  }
  return Math.round(value * 1000) / 1000;
}

function boundedLatencyState(input: unknown): number {
  const value = Number(input ?? 0);
  if (!Number.isFinite(value) || value < 0 || value > MAX_LATENCY_MS) throw corrupt('Learning latency is invalid.');
  return value;
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
