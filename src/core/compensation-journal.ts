import path from 'node:path';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { OperatorError } from './errors.ts';

export interface DurableCompensationIntent {
  id: string;
  ownerKind: string;
  ownerId: string;
  operation: string;
  targetId: string;
  subjectKey?: string;
  createdAt: string;
}

interface CompensationState {
  version: 1;
  intents: DurableCompensationIntent[];
}

const MAX_INTENTS = 10_000;
const STORE_OPTIONS = {
  maxBytes: 8 * 1024 * 1024,
  errorCode: 'COMPENSATION_JOURNAL_CORRUPT',
  invalidMessage: 'Durable compensation journal is invalid.'
} as const;

export class DurableCompensationJournal {
  #file: string;
  #serial: Promise<void> = Promise.resolve();
  #clock: () => Date;

  constructor(stateDir: string, options: { clock?: () => Date } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'compensation-intents.json');
    this.#clock = options.clock ?? (() => new Date());
  }

  async prepare(input: Omit<DurableCompensationIntent, 'createdAt'>): Promise<DurableCompensationIntent> {
    return await this.#mutate((state) => {
      const candidate = normalizeIntent({ ...input, createdAt: this.#clock().toISOString() });
      const existing = state.intents.find((item) => item.id === candidate.id);
      if (existing) {
        if (sameIntent(existing, candidate)) return existing;
        throw new OperatorError('COMPENSATION_INTENT_CONFLICT', 'Compensation intent id is already bound to a different recovery contract.');
      }
      if (state.intents.length >= MAX_INTENTS) throw new OperatorError('COMPENSATION_JOURNAL_LIMIT', 'Too many pending durable compensation intents.');
      state.intents.push(candidate);
      state.intents.sort((a, b) => a.id.localeCompare(b.id));
      return candidate;
    });
  }

  async complete(idInput: string): Promise<void> {
    const id = bounded(idInput, 256, 'id');
    await this.#mutate((state) => {
      state.intents = state.intents.filter((item) => item.id !== id);
    });
  }

  async pending(ownerKindInput?: string): Promise<DurableCompensationIntent[]> {
    await this.#serial;
    const state = await this.#read();
    const ownerKind = ownerKindInput === undefined ? undefined : bounded(ownerKindInput, 128, 'ownerKind');
    return state.intents
      .filter((item) => ownerKind === undefined || item.ownerKind === ownerKind)
      .map((item) => structuredClone(item));
  }

  async #read(): Promise<CompensationState> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, STORE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, intents: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('COMPENSATION_JOURNAL_CORRUPT', 'Durable compensation journal could not be read.');
    }
  }

  async #mutate<T>(fn: (state: CompensationState) => T | Promise<T>): Promise<T> {
    let output!: T;
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      output = await fn(state);
      validateState(state);
      await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STORE_OPTIONS);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
    return structuredClone(output);
  }
}

function validateState(input: unknown): CompensationState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('State must be an object.');
  const state = input as CompensationState;
  if (state.version !== 1 || !Array.isArray(state.intents) || state.intents.length > MAX_INTENTS) throw corrupt('State shape is invalid.');
  const ids = new Set<string>();
  state.intents = state.intents.map((item) => {
    const normalized = normalizeIntent(item);
    if (ids.has(normalized.id)) throw corrupt('Intent ids must be unique.');
    ids.add(normalized.id);
    return normalized;
  });
  return state;
}

function normalizeIntent(input: DurableCompensationIntent): DurableCompensationIntent {
  return {
    id: bounded(input.id, 256, 'id'),
    ownerKind: bounded(input.ownerKind, 128, 'ownerKind'),
    ownerId: bounded(input.ownerId, 256, 'ownerId'),
    operation: bounded(input.operation, 128, 'operation'),
    targetId: bounded(input.targetId, 256, 'targetId'),
    ...(input.subjectKey === undefined ? {} : { subjectKey: bounded(input.subjectKey, 256, 'subjectKey') }),
    createdAt: iso(input.createdAt)
  };
}

function sameIntent(a: DurableCompensationIntent, b: DurableCompensationIntent): boolean {
  return a.id === b.id && a.ownerKind === b.ownerKind && a.ownerId === b.ownerId
    && a.operation === b.operation && a.targetId === b.targetId && a.subjectKey === b.subjectKey;
}

function bounded(input: unknown, max: number, label: string): string {
  const value = String(input ?? '');
  if (value.length < 1 || value.length > max || value.includes('\0')) {
    throw new OperatorError('COMPENSATION_JOURNAL_INPUT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function iso(input: unknown): string {
  const value = String(input ?? '');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw corrupt('Timestamp is invalid.');
  return value;
}

function corrupt(message: string): OperatorError {
  return new OperatorError('COMPENSATION_JOURNAL_CORRUPT', `Durable compensation journal is invalid. ${message}`);
}
