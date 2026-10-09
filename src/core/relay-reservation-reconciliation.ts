import crypto from 'node:crypto';
import path from 'node:path';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { withDurableStateLock } from './durable-state-lock.ts';
import { OperatorError } from './errors.ts';

export interface RelayReservationReconciliation {
  id: string;
  accountId: string;
  operationId: string;
  workloadKey: string;
  reservationId: string;
  sessionId: string;
  action: 'renew' | 'release';
  leaseMs?: number;
  state: 'PENDING' | 'RESOLVED';
  errorCode: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

type State = { version: 1; records: RelayReservationReconciliation[] };
const OPTIONS = { maxBytes: 4 * 1024 * 1024, errorCode: 'RELAY_RESERVATION_RECONCILIATION_CORRUPT', invalidMessage: 'Relay reservation reconciliation state is invalid.' } as const;
const MAX_RECORDS = 5000;

export class RelayReservationReconciliationStore {
  #file: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.#file = path.join(path.resolve(stateDir), 'relay-reservation-reconciliation.json');
  }

  record(input: Omit<RelayReservationReconciliation, 'id' | 'state' | 'attempts' | 'createdAt' | 'updatedAt'>): Promise<RelayReservationReconciliation> {
    return this.#mutate((state, now) => {
      const existing = state.records.find((item) => item.state === 'PENDING' && item.accountId === input.accountId && item.reservationId === input.reservationId && item.action === input.action);
      if (existing) {
        // A reservation identity cannot alias another operation, session or
        // renewal contract. Preserving the original record silently would
        // allow restart recovery to act on unrelated/stale capacity authority.
        if (existing.operationId !== input.operationId || existing.workloadKey !== input.workloadKey ||
            existing.sessionId !== input.sessionId || existing.leaseMs !== input.leaseMs) {
          throw new OperatorError('RELAY_RESERVATION_RECONCILIATION_CONFLICT', 'Existing pending reservation belongs to a different recovery contract.');
        }
        existing.errorCode = validCode(input.errorCode);
        existing.attempts += 1;
        existing.updatedAt = now;
        return existing;
      }
      if (state.records.length >= MAX_RECORDS) {
        const terminal = state.records.filter((item) => item.state === 'RESOLVED').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
        if (terminal.length === 0) throw new OperatorError('RELAY_RESERVATION_RECONCILIATION_LIMIT', 'Reservation reconciliation queue is full of unresolved records.');
        state.records.splice(state.records.indexOf(terminal[0]!), 1);
      }
      const record: RelayReservationReconciliation = {
        ...input,
        errorCode: validCode(input.errorCode),
        id: crypto.randomUUID(),
        state: 'PENDING',
        attempts: 1,
        createdAt: now,
        updatedAt: now
      };
      state.records.push(record);
      return record;
    });
  }

  resolve(id: string): Promise<RelayReservationReconciliation> {
    return this.#mutate((state, now) => {
      const record = state.records.find((item) => item.id === id);
      if (!record) throw new OperatorError('RELAY_RESERVATION_RECONCILIATION_NOT_FOUND', 'Reservation reconciliation record was not found.');
      record.state = 'RESOLVED';
      record.resolvedAt = now;
      record.updatedAt = now;
      return record;
    });
  }

  async pending(): Promise<RelayReservationReconciliation[]> {
    await this.#queue;
    return (await this.#read()).records.filter((item) => item.state === 'PENDING').map((item) => structuredClone(item));
  }

  async #mutate<T>(fn: (state: State, now: string) => T): Promise<T> {
    let output!: T;
    const operation = this.#queue.then(() => withDurableStateLock(this.#file, async () => {
      const state = await this.#read();
      output = fn(state, new Date().toISOString());
      validateState(state);
      await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), OPTIONS);
    }));
    this.#queue = operation.then(() => undefined, () => undefined);
    await operation;
    return structuredClone(output);
  }

  async #read(): Promise<State> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('RELAY_RESERVATION_RECONCILIATION_CORRUPT', 'Relay reservation reconciliation state is invalid.');
    }
  }
}

function validCode(input: string): string {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(input) ? input : 'RELAY_RESERVATION_BOOKKEEPING_FAILED';
}

function validateState(input: unknown): State {
  const fail = (): never => {
    throw new OperatorError('RELAY_RESERVATION_RECONCILIATION_CORRUPT', 'Relay reservation reconciliation state has invalid recovery identity or lifecycle.');
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
  const raw = input as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.records) || raw.records.length > MAX_RECORDS) return fail();

  const uuid = (value: unknown): value is string =>
    typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const timestamp = (value: unknown): value is string => {
    if (typeof value !== 'string') return false;
    const millis = Date.parse(value);
    return Number.isFinite(millis) && new Date(millis).toISOString() === value;
  };
  const ids = new Set<string>();
  const pendingKeys = new Set<string>();
  for (const item of raw.records) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail();
    const record = item as Record<string, unknown>;
    if (!uuid(record.id) || !uuid(record.accountId) || !uuid(record.operationId) ||
        !uuid(record.reservationId) || !uuid(record.sessionId) ||
        typeof record.workloadKey !== 'string' ||
        !/^[A-Za-z0-9._:@/+=-]{1,256}$/.test(record.workloadKey) ||
        (record.action !== 'renew' && record.action !== 'release') ||
        (record.state !== 'PENDING' && record.state !== 'RESOLVED') ||
        (typeof record.attempts !== 'number' || !Number.isSafeInteger(record.attempts) || record.attempts < 1) ||
        typeof record.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(record.errorCode) ||
        !timestamp(record.createdAt) || !timestamp(record.updatedAt) ||
        Date.parse(record.updatedAt as string) < Date.parse(record.createdAt as string) ||
        (record.leaseMs !== undefined && (typeof record.leaseMs !== 'number' || !Number.isSafeInteger(record.leaseMs) || record.leaseMs < 1)) ||
        (record.action === 'renew' && record.leaseMs === undefined) ||
        (record.state === 'RESOLVED' && (!timestamp(record.resolvedAt) || Date.parse(record.resolvedAt as string) > Date.parse(record.updatedAt as string))) ||
        (record.state === 'PENDING' && record.resolvedAt !== undefined)) return fail();
    if (ids.has(record.id)) return fail();
    ids.add(record.id);
    if (record.state === 'PENDING') {
      const key = JSON.stringify([record.accountId, record.reservationId, record.action]);
      if (pendingKeys.has(key)) return fail();
      pendingKeys.add(key);
    }
  }
  return input as State;
}
