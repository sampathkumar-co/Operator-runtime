import crypto from 'node:crypto';
import path from 'node:path';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
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
    const operation = this.#queue.then(async () => {
      const state = await this.#read();
      output = fn(state, new Date().toISOString());
      await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), OPTIONS);
    });
    this.#queue = operation.then(() => undefined, () => undefined);
    await operation;
    return structuredClone(output);
  }

  async #read(): Promise<State> {
    try {
      const state = JSON.parse(await readDurableStateText(this.#file, OPTIONS)) as State;
      if (state.version !== 1 || !Array.isArray(state.records) || state.records.length > MAX_RECORDS) throw new Error('shape');
      return state;
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
