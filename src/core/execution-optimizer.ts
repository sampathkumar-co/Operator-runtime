import path from 'node:path';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

const MAX_ENTRIES = 5000;
const MAX_COUNTER = 10_000;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_SCORE_ADJUSTMENT = 0.1;
const MAX_DURATION_MS = 24 * 60 * 60_000;
const MAX_COST = 1_000_000;

export interface StrategyOutcome {
  verified: boolean;
  durationMs?: number;
  retries?: number;
  costUnits?: number;
}

interface StrategyEntry {
  context: string;
  strategy: string;
  verified: number;
  failed: number;
  durationEwmaMs: number;
  retriesEwma: number;
  costEwma: number;
  samples: number;
  updatedAt: string;
}

interface OptimizerState {
  version: 1;
  entries: StrategyEntry[];
}

export interface StrategyCandidate {
  id: string;
  staticScore: number;
}

export interface StrategyRecommendation {
  id: string;
  score: number;
  staticScore: number;
  learnedAdjustment: number;
  samples: number;
}

const STORE_OPTIONS = {
  maxBytes: MAX_STATE_BYTES,
  errorCode: 'EXECUTION_OPTIMIZER_CORRUPT',
  invalidMessage: 'Execution optimizer state is invalid.'
} as const;

export class ExecutionOptimizerStore {
  #file: string;
  #clock: () => Date;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: { clock?: () => Date } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'execution-optimizer.json');
    this.#clock = options.clock ?? (() => new Date());
  }

  async record(contextInput: string, strategyInput: string, outcome: StrategyOutcome): Promise<void> {
    const context = boundedKey(contextInput, 'context');
    const strategy = boundedKey(strategyInput, 'strategy');
    const normalized = normalizeOutcome(outcome);
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      let entry = state.entries.find((item) => item.context === context && item.strategy === strategy);
      if (!entry) {
        if (state.entries.length >= MAX_ENTRIES) {
          state.entries.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
          state.entries.shift();
        }
        entry = {
          context, strategy, verified: 0, failed: 0,
          durationEwmaMs: 0, retriesEwma: 0, costEwma: 0, samples: 0,
          updatedAt: this.#clock().toISOString()
        };
        state.entries.push(entry);
      }
      if (entry.verified + entry.failed >= MAX_COUNTER) {
        entry.verified = Math.floor(entry.verified / 2);
        entry.failed = Math.floor(entry.failed / 2);
        entry.samples = Math.floor(entry.samples / 2);
      }
      if (normalized.verified) entry.verified += 1;
      else entry.failed += 1;
      entry.samples = Math.min(MAX_COUNTER, entry.samples + 1);
      entry.durationEwmaMs = ewma(entry.durationEwmaMs, normalized.durationMs ?? 0, entry.samples);
      entry.retriesEwma = ewma(entry.retriesEwma, normalized.retries, entry.samples);
      entry.costEwma = ewma(entry.costEwma, normalized.costUnits, entry.samples);
      entry.updatedAt = this.#clock().toISOString();
      state.entries.sort((a, b) => identity(a).localeCompare(identity(b)));
      await this.#write(state);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
  }

  async recommend(contextInput: string, candidatesInput: StrategyCandidate[]): Promise<StrategyRecommendation[]> {
    const context = boundedKey(contextInput, 'context');
    if (!Array.isArray(candidatesInput) || candidatesInput.length < 1 || candidatesInput.length > 200) throw new OperatorError('EXECUTION_OPTIMIZER_INPUT_INVALID', 'Candidates must contain 1-200 pre-authorized strategies.');
    const seen = new Set<string>();
    const candidates = candidatesInput.map((candidate, index) => {
      const id = boundedKey(candidate.id, `candidates[${index}].id`);
      if (seen.has(id)) throw new OperatorError('EXECUTION_OPTIMIZER_INPUT_INVALID', 'Candidate strategy IDs must be unique.');
      seen.add(id);
      const staticScore = boundedUnit(candidate.staticScore, `candidates[${index}].staticScore`);
      return { id, staticScore };
    });
    await this.#serial;
    const state = await this.#read();
    return candidates.map((candidate) => {
      const entry = state.entries.find((item) => item.context === context && item.strategy === candidate.id);
      const learnedAdjustment = entry ? strategyAdjustment(entry) : 0;
      return {
        id: candidate.id,
        score: clamp(candidate.staticScore + learnedAdjustment, 0, 1),
        staticScore: candidate.staticScore,
        learnedAdjustment,
        samples: entry?.samples ?? 0
      };
    }).sort((a, b) => b.score - a.score || b.staticScore - a.staticScore || a.id.localeCompare(b.id));
  }

  async recommendConcurrency(contextInput: string, strategyInput: string, input: {
    current: number;
    min: number;
    policyMax: number;
  }): Promise<number> {
    const context = boundedKey(contextInput, 'context');
    const strategy = boundedKey(strategyInput, 'strategy');
    const min = boundedInteger(input.min, 1, 10_000, 'min');
    const policyMax = boundedInteger(input.policyMax, min, 10_000, 'policyMax');
    const current = boundedInteger(input.current, min, policyMax, 'current');
    await this.#serial;
    const state = await this.#read();
    const entry = state.entries.find((item) => item.context === context && item.strategy === strategy);
    if (!entry || entry.samples < 5) return current;
    const reliability = (entry.verified + 2) / (entry.verified + entry.failed + 4);
    if (reliability >= 0.9 && entry.retriesEwma <= 0.25) return Math.min(policyMax, current + 1);
    if (reliability < 0.7 || entry.retriesEwma >= 1.5) return Math.max(min, current - 1);
    return current;
  }

  async inspect(limitInput = 200): Promise<StrategyEntry[]> {
    await this.#serial;
    const limit = boundedInteger(limitInput, 1, 1000, 'limit');
    const state = await this.#read();
    return state.entries.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map((item) => structuredClone(item));
  }

  async #read(): Promise<OptimizerState> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, STORE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('EXECUTION_OPTIMIZER_CORRUPT', 'Execution optimizer state could not be read.');
    }
  }

  async #write(state: OptimizerState): Promise<void> {
    validateState(state);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STORE_OPTIONS);
  }
}

function strategyAdjustment(entry: StrategyEntry): number {
  if (entry.samples < 2) return 0;
  const reliability = (entry.verified + 2) / (entry.verified + entry.failed + 4);
  const confidence = Math.min(1, entry.samples / 30);
  const reliabilityTerm = (reliability - 0.5) * 0.16 * confidence;
  const latencyPenalty = entry.durationEwmaMs <= 100 ? 0 : Math.min(0.02, Math.log10(entry.durationEwmaMs / 100 + 1) * 0.006);
  const retryPenalty = Math.min(0.025, entry.retriesEwma * 0.01);
  const costPenalty = Math.min(0.015, Math.log10(entry.costEwma + 1) * 0.003);
  return Math.round(clamp(reliabilityTerm - latencyPenalty - retryPenalty - costPenalty, -MAX_SCORE_ADJUSTMENT, MAX_SCORE_ADJUSTMENT) * 1_000_000) / 1_000_000;
}

function normalizeOutcome(outcome: StrategyOutcome) {
  if (!outcome || typeof outcome !== 'object' || typeof outcome.verified !== 'boolean') throw new OperatorError('EXECUTION_OPTIMIZER_INPUT_INVALID', 'Strategy outcome is invalid.');
  return {
    verified: outcome.verified,
    durationMs: outcome.durationMs === undefined ? undefined : boundedNumber(outcome.durationMs, 0, MAX_DURATION_MS, 'durationMs'),
    retries: boundedNumber(outcome.retries ?? 0, 0, 1000, 'retries'),
    costUnits: boundedNumber(outcome.costUnits ?? 0, 0, MAX_COST, 'costUnits')
  };
}

function ewma(current: number, sample: number, samples: number): number {
  if (samples <= 1) return sample;
  return Math.round((current * 0.8 + sample * 0.2) * 1000) / 1000;
}

function validateState(input: unknown): OptimizerState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('State must be an object.');
  const state = input as OptimizerState;
  if (state.version !== 1 || !Array.isArray(state.entries) || state.entries.length > MAX_ENTRIES) throw corrupt('State shape is invalid.');
  const seen = new Set<string>();
  for (const entry of state.entries) {
    boundedKey(entry.context, 'context'); boundedKey(entry.strategy, 'strategy');
    const key = identity(entry);
    if (seen.has(key)) throw corrupt('Strategy entries must be unique.');
    seen.add(key);
    boundedInteger(entry.verified, 0, MAX_COUNTER, 'verified'); boundedInteger(entry.failed, 0, MAX_COUNTER, 'failed'); boundedInteger(entry.samples, 0, MAX_COUNTER, 'samples');
    boundedNumber(entry.durationEwmaMs, 0, MAX_DURATION_MS, 'durationEwmaMs'); boundedNumber(entry.retriesEwma, 0, 1000, 'retriesEwma'); boundedNumber(entry.costEwma, 0, MAX_COST, 'costEwma');
    validIso(entry.updatedAt, 'updatedAt');
  }
  return structuredClone(state);
}
function identity(entry: Pick<StrategyEntry, 'context' | 'strategy'>): string { return `${entry.context}\0${entry.strategy}`; }
function boundedKey(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(value)) throw new OperatorError('EXECUTION_OPTIMIZER_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function boundedUnit(input: unknown, label: string): number { return boundedNumber(input, 0, 1, label); }
function boundedNumber(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value < min || value > max) throw new OperatorError('EXECUTION_OPTIMIZER_INPUT_INVALID', `${label} is invalid.`);
  return Math.round(value * 1000) / 1000;
}
function boundedInteger(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new OperatorError('EXECUTION_OPTIMIZER_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function validIso(input: unknown, label: string): string {
  const value = String(input ?? ''); const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new OperatorError('EXECUTION_OPTIMIZER_INPUT_INVALID', `${label} must be ISO timestamp.`);
  return value;
}
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function corrupt(message: string): OperatorError { return new OperatorError('EXECUTION_OPTIMIZER_CORRUPT', `Execution optimizer state is invalid. ${message}`); }
