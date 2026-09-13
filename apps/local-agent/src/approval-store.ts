import path from 'node:path';
import type { ActionRequest } from '../../../src/core/types.ts';
import { actionHash } from '../../../src/core/action-identity.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { readDurableStateText, writeDurableStateText } from '../../../src/core/durable-state.ts';

const MAX_RECORDS = 2000;
const RETENTION_MS = 24 * 60 * 60_000;
const APPROVAL_TTL_MS = 10 * 60_000;

export type ApprovalStatus = 'pending' | 'approved' | 'consumed' | 'denied';

export type ApprovalRecord = {
  actionId: string;
  actionHash: string;
  capability: string;
  risk: ActionRequest['risk'];
  target?: string;
  status: ApprovalStatus;
  createdAt: string;
  approvedAt?: string;
  approvalExpiresAt?: string;
  consumedAt?: string;
  deniedAt?: string;
};

type State = { version: 1; records: ApprovalRecord[] };
export class ApprovalStore {
  #file: string;
  #clock: () => Date;
  #queue: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: { clock?: () => Date } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'approvals.json');
    this.#clock = options.clock ?? (() => new Date());
  }

  async register(action: ActionRequest): Promise<ApprovalRecord> {
    const hash = actionHash(action);
    return await this.#mutate((state) => {
      prune(state, this.#clock().getTime());
      const existing = state.records.find((entry) => entry.actionId === action.id);
      if (existing && existing.actionHash !== hash) {
        throw new OperatorError('APPROVAL_ACTION_MISMATCH', 'Action ID is already bound to different action content.');
      }
      if (existing && (existing.status === 'pending' || existing.status === 'approved')) return clone(existing);
      const record: ApprovalRecord = {
        actionId: action.id,
        actionHash: hash,
        capability: action.capability,
        risk: action.risk,
        target: action.target,
        status: 'pending',
        createdAt: this.#clock().toISOString()
      };
      if (existing) Object.assign(existing, record, {
        approvedAt: undefined,
        approvalExpiresAt: undefined,
        consumedAt: undefined,
        deniedAt: undefined
      });
      else {
        if (state.records.length >= MAX_RECORDS) throw new OperatorError('APPROVAL_STORE_LIMIT', 'Approval store is full.');
        state.records.push(record);
      }
      return clone(existing ?? record);
    });
  }

  async list(): Promise<ApprovalRecord[]> {
    const state = await this.#read();
    const now = this.#clock().getTime();
    return state.records
      .filter((entry) => Date.parse(entry.createdAt) >= now - RETENTION_MS)
      .slice()
      .reverse()
      .map(clone);
  }

  async approve(actionId: string): Promise<ApprovalRecord> {
    return await this.#mutate((state) => {
      const record = requireRecord(state, actionId);
      if (record.status !== 'pending') throw new OperatorError('APPROVAL_NOT_PENDING', 'Only pending actions can be approved.');
      const now = this.#clock();
      record.status = 'approved';
      record.approvedAt = now.toISOString();
      record.approvalExpiresAt = new Date(now.getTime() + APPROVAL_TTL_MS).toISOString();
      return clone(record);
    });
  }

  async deny(actionId: string): Promise<ApprovalRecord> {
    return await this.#mutate((state) => {
      const record = requireRecord(state, actionId);
      if (record.status !== 'pending' && record.status !== 'approved') {
        throw new OperatorError('APPROVAL_NOT_ACTIVE', 'Only pending or approved actions can be denied.');
      }
      record.status = 'denied';
      record.deniedAt = this.#clock().toISOString();
      return clone(record);
    });
  }

  async isApproved(action: ActionRequest): Promise<boolean> {
    const state = await this.#read();
    const record = state.records.find((entry) => entry.actionId === action.id);
    if (!record || record.status !== 'approved' || record.actionHash !== actionHash(action) || !record.approvalExpiresAt) return false;
    return Date.parse(record.approvalExpiresAt) > this.#clock().getTime();
  }
  async consume(action: ActionRequest): Promise<void> {
    await this.#mutate((state) => {
      const record = requireRecord(state, action.id);
      if (record.status !== 'approved' || record.actionHash !== actionHash(action)) {
        throw new OperatorError('APPROVAL_NOT_VALID', 'Action approval is not valid for this exact action.');
      }
      if (!record.approvalExpiresAt || Date.parse(record.approvalExpiresAt) <= this.#clock().getTime()) {
        throw new OperatorError('APPROVAL_EXPIRED', 'Action approval has expired.');
      }
      record.status = 'consumed';
      record.consumedAt = this.#clock().toISOString();
    });
  }

  async #read(): Promise<State> {
    try {
      const text = await readDurableStateText(this.#file, {
        maxBytes: 4 * 1024 * 1024,
        errorCode: 'APPROVAL_STORE_CORRUPT',
        invalidMessage: 'Approval store is invalid.'
      });
      return validateState(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] };
      throw error;
    }
  }
  async #write(state: State): Promise<void> {
    await writeDurableStateText(this.#file, JSON.stringify(validateState(state), null, 2), {
      maxBytes: 4 * 1024 * 1024,
      errorCode: 'APPROVAL_STORE_CORRUPT',
      invalidMessage: 'Approval store is invalid.'
    });
  }

  async #mutate<T>(fn: (state: State) => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.#queue;
    this.#queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const state = await this.#read();
      const value = await fn(state);
      await this.#write(state);
      return value;
    } finally {
      release();
    }
  }
}

function requireRecord(state: State, actionId: string): ApprovalRecord {
  const record = state.records.find((entry) => entry.actionId === actionId);
  if (!record) throw new OperatorError('APPROVAL_NOT_FOUND', 'Approval request was not found.');
  return record;
}
function prune(state: State, now: number): void {
  state.records = state.records.filter((entry) => Date.parse(entry.createdAt) >= now - RETENTION_MS);
}

function clone(record: ApprovalRecord): ApprovalRecord {
  return { ...record };
}

function validateState(input: State): State {
  if (!input || typeof input !== 'object' || input.version !== 1 || !Array.isArray(input.records) || input.records.length > MAX_RECORDS) {
    throw new OperatorError('APPROVAL_STORE_CORRUPT', 'Approval store structure is invalid.');
  }
  const ids = new Set<string>();
  const records = input.records.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new OperatorError('APPROVAL_STORE_CORRUPT', 'Approval record is invalid.');
    if (typeof entry.actionId !== 'string' || !entry.actionId || entry.actionId.length > 256 || ids.has(entry.actionId)) {
      throw new OperatorError('APPROVAL_STORE_CORRUPT', 'Approval action ID is invalid or duplicated.');
    }
    ids.add(entry.actionId);
    if (!/^[0-9a-f]{64}$/.test(entry.actionHash)) throw new OperatorError('APPROVAL_STORE_CORRUPT', 'Approval action hash is invalid.');
    if (!['read', 'write', 'external', 'system', 'destructive'].includes(entry.risk)) throw new OperatorError('APPROVAL_STORE_CORRUPT', 'Approval risk is invalid.');
    if (!['pending', 'approved', 'consumed', 'denied'].includes(entry.status)) throw new OperatorError('APPROVAL_STORE_CORRUPT', 'Approval status is invalid.');
    return { ...entry };
  });
  return { version: 1, records };
}
