import crypto from 'node:crypto';
import path from 'node:path';
import type { ActionRequest } from '../../../src/core/types.ts';
import { actionHash, canonicalJson } from '../../../src/core/action-identity.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { readDurableStateText, writeDurableStateText } from '../../../src/core/durable-state.ts';

const MAX_RECORDS = 2000;
const RETENTION_MS = 24 * 60 * 60_000;
const PENDING_TTL_MS = 10 * 60_000;
const APPROVAL_TTL_MS = 10 * 60_000;

export type ApprovalStatus = 'pending' | 'approved' | 'consumed' | 'denied';
export type ApprovalAuthorityContext = {
  accountId: string;
  deviceId: string;
  generation: number;
};

export type ApprovalRecord = {
  actionId: string;
  actionHash: string;
  authorityHash: string;
  approvalRequestId: string;
  capability: string;
  risk: ActionRequest['risk'];
  target?: string;
  status: ApprovalStatus;
  createdAt: string;
  pendingExpiresAt: string;
  approvedAt?: string;
  approvalExpiresAt?: string;
  consumedAt?: string;
  deniedAt?: string;
};

type State = { version: 2; records: ApprovalRecord[] };
type LegacyState = { version: 1; records: unknown[] };

export class ApprovalStore {
  #file: string;
  #clock: () => Date;
  #queue: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: { clock?: () => Date } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'approvals.json');
    this.#clock = options.clock ?? (() => new Date());
  }

  async register(action: ActionRequest, authority?: ApprovalAuthorityContext): Promise<ApprovalRecord> {
    const hash = actionHash(action);
    const boundAuthority = approvalAuthorityHash(authority);
    return await this.#mutate((state) => {
      const now = this.#clock();
      prune(state, now.getTime());
      const existing = state.records.find((entry) => entry.actionId === action.id);
      if (existing && existing.actionHash !== hash) {
        throw new OperatorError('APPROVAL_ACTION_MISMATCH', 'Action ID is already bound to different action content.');
      }
      if (
        existing
        && existing.authorityHash === boundAuthority
        && existing.status === 'pending'
        && Date.parse(existing.pendingExpiresAt) > now.getTime()
      ) return clone(existing);
      if (
        existing
        && existing.authorityHash === boundAuthority
        && existing.status === 'approved'
        && existing.approvalExpiresAt
        && Date.parse(existing.approvalExpiresAt) > now.getTime()
      ) return clone(existing);

      const record: ApprovalRecord = {
        actionId: action.id,
        actionHash: hash,
        authorityHash: boundAuthority,
        approvalRequestId: crypto.randomUUID(),
        capability: action.capability,
        risk: action.risk,
        target: action.target,
        status: 'pending',
        createdAt: now.toISOString(),
        pendingExpiresAt: new Date(now.getTime() + PENDING_TTL_MS).toISOString()
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
    return await this.#mutate((state) => {
      prune(state, this.#clock().getTime());
      return state.records.slice().reverse().map(clone);
    });
  }

  async approve(actionId: string, approvalRequestId: string): Promise<ApprovalRecord> {
    const outcome = await this.#mutate((state) => {
      const record = requireRecord(state, actionId);
      requireApprovalRequest(record, approvalRequestId);
      const now = this.#clock();
      if (Date.parse(record.pendingExpiresAt) <= now.getTime()) {
        removeRecord(state, actionId);
        return { expired: true as const };
      }
      if (record.status !== 'pending') {
        throw new OperatorError('APPROVAL_NOT_PENDING', 'Only pending actions can be approved.');
      }
      record.status = 'approved';
      record.approvedAt = now.toISOString();
      record.approvalExpiresAt = new Date(now.getTime() + APPROVAL_TTL_MS).toISOString();
      return { record: clone(record) };
    });
    if ('expired' in outcome) throw new OperatorError('APPROVAL_EXPIRED', 'Approval request has expired.');
    return outcome.record;
  }

  async deny(actionId: string, approvalRequestId: string): Promise<ApprovalRecord> {
    const outcome = await this.#mutate((state) => {
      const record = requireRecord(state, actionId);
      requireApprovalRequest(record, approvalRequestId);
      const now = this.#clock();
      const expired = record.status === 'pending'
        ? Date.parse(record.pendingExpiresAt) <= now.getTime()
        : record.status === 'approved'
          ? !record.approvalExpiresAt || Date.parse(record.approvalExpiresAt) <= now.getTime()
          : false;
      if (expired) {
        removeRecord(state, actionId);
        return { expired: true as const };
      }
      if (record.status !== 'pending' && record.status !== 'approved') {
        throw new OperatorError('APPROVAL_NOT_ACTIVE', 'Only pending or approved actions can be denied.');
      }
      record.status = 'denied';
      record.deniedAt = now.toISOString();
      return { record: clone(record) };
    });
    if ('expired' in outcome) throw new OperatorError('APPROVAL_EXPIRED', 'Approval request has expired.');
    return outcome.record;
  }

  async isApproved(action: ActionRequest, authority?: ApprovalAuthorityContext): Promise<boolean> {
    const expectedHash = actionHash(action);
    const expectedAuthority = approvalAuthorityHash(authority);
    return await this.#mutate((state) => {
      prune(state, this.#clock().getTime());
      const record = state.records.find((entry) => entry.actionId === action.id);
      if (!record || record.status !== 'approved') return false;
      if (record.actionHash !== expectedHash || record.authorityHash !== expectedAuthority) return false;
      if (!record.approvalExpiresAt) return false;
      return Date.parse(record.approvalExpiresAt) > this.#clock().getTime();
    });
  }

  async consume(action: ActionRequest, authority?: ApprovalAuthorityContext): Promise<void> {
    const expectedHash = actionHash(action);
    const expectedAuthority = approvalAuthorityHash(authority);
    const outcome = await this.#mutate((state) => {
      const record = requireRecord(state, action.id);
      if (record.status !== 'approved' || record.actionHash !== expectedHash || record.authorityHash !== expectedAuthority) {
        throw new OperatorError('APPROVAL_NOT_VALID', 'Action approval is not valid for this exact action and authority.');
      }
      if (!record.approvalExpiresAt || Date.parse(record.approvalExpiresAt) <= this.#clock().getTime()) {
        removeRecord(state, action.id);
        return { expired: true as const };
      }
      record.status = 'consumed';
      record.consumedAt = this.#clock().toISOString();
      return { ok: true as const };
    });
    if ('expired' in outcome) throw new OperatorError('APPROVAL_EXPIRED', 'Action approval has expired.');
  }

  async #read(): Promise<State> {
    try {
      const text = await readDurableStateText(this.#file, {
        maxBytes: 4 * 1024 * 1024,
        errorCode: 'APPROVAL_STORE_CORRUPT',
        invalidMessage: 'Approval store is invalid.'
      });
      const parsed = JSON.parse(text) as State | LegacyState;
      if (parsed?.version === 1) return { version: 2, records: [] };
      return validateState(parsed as State);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, records: [] };
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

function approvalAuthorityHash(authority?: ApprovalAuthorityContext): string {
  const normalized = authority === undefined
    ? { kind: 'local' as const }
    : {
        kind: 'account' as const,
        accountId: validUuid(authority.accountId, 'approval accountId'),
        deviceId: validUuid(authority.deviceId, 'approval deviceId'),
        generation: validGeneration(authority.generation)
      };
  return crypto.createHash('sha256').update(canonicalJson(normalized), 'utf8').digest('hex');
}
function requireRecord(state: State, actionId: string): ApprovalRecord {
  const record = state.records.find((entry) => entry.actionId === actionId);
  if (!record) throw new OperatorError('APPROVAL_NOT_FOUND', 'Approval request was not found.');
  return record;
}

function requireApprovalRequest(record: ApprovalRecord, approvalRequestId: string): void {
  if (typeof approvalRequestId !== 'string' || approvalRequestId !== record.approvalRequestId) {
    throw new OperatorError('APPROVAL_REQUEST_MISMATCH', 'Approval request identity is stale or invalid.');
  }
}

function removeRecord(state: State, actionId: string): void {
  state.records = state.records.filter((entry) => entry.actionId !== actionId);
}

function prune(state: State, now: number): void {
  state.records = state.records.filter((entry) => {
    if (Date.parse(entry.createdAt) < now - RETENTION_MS) return false;
    if (entry.status === 'pending' && Date.parse(entry.pendingExpiresAt) <= now) return false;
    if (entry.status === 'approved' && (!entry.approvalExpiresAt || Date.parse(entry.approvalExpiresAt) <= now)) return false;
    return true;
  });
}

function clone(record: ApprovalRecord): ApprovalRecord { return { ...record }; }
function validateState(input: State): State {
  if (!input || typeof input !== 'object' || input.version !== 2 || !Array.isArray(input.records) || input.records.length > MAX_RECORDS) {
    throw corrupt('Approval store structure is invalid.');
  }
  const actionIds = new Set<string>();
  const requestIds = new Set<string>();
  const records = input.records.map((raw) => {
    if (!raw || typeof raw !== 'object') throw corrupt('Approval record is invalid.');
    const actionId = validStoredText(raw.actionId, 256, 'action ID');
    if (actionIds.has(actionId)) throw corrupt('Approval action ID is duplicated.');
    actionIds.add(actionId);
    const actionHashValue = String(raw.actionHash ?? '');
    const authorityHash = String(raw.authorityHash ?? '');
    if (!/^[0-9a-f]{64}$/.test(actionHashValue) || !/^[0-9a-f]{64}$/.test(authorityHash)) {
      throw corrupt('Approval hashes are invalid.');
    }
    const approvalRequestId = String(raw.approvalRequestId ?? '');
    if (!isUuid(approvalRequestId) || requestIds.has(approvalRequestId)) throw corrupt('Approval request ID is invalid or duplicated.');
    requestIds.add(approvalRequestId);
    const capability = validStoredText(raw.capability, 128, 'capability');
    const risk = raw.risk;
    if (!['read', 'write', 'external', 'system', 'destructive'].includes(risk)) throw corrupt('Approval risk is invalid.');
    const status = raw.status;
    if (!['pending', 'approved', 'consumed', 'denied'].includes(status)) throw corrupt('Approval status is invalid.');
    const target = raw.target === undefined ? undefined : validStoredText(raw.target, 4096, 'target');
    const createdAt = validIso(raw.createdAt, 'createdAt');
    const pendingExpiresAt = validIso(raw.pendingExpiresAt, 'pendingExpiresAt');
    if (Date.parse(pendingExpiresAt) <= Date.parse(createdAt)) throw corrupt('Pending approval expiry is invalid.');
    const approvedAt = raw.approvedAt === undefined ? undefined : validIso(raw.approvedAt, 'approvedAt');
    const approvalExpiresAt = raw.approvalExpiresAt === undefined ? undefined : validIso(raw.approvalExpiresAt, 'approvalExpiresAt');
    const consumedAt = raw.consumedAt === undefined ? undefined : validIso(raw.consumedAt, 'consumedAt');
    const deniedAt = raw.deniedAt === undefined ? undefined : validIso(raw.deniedAt, 'deniedAt');

    if (status === 'pending' && (approvedAt || approvalExpiresAt || consumedAt || deniedAt)) throw corrupt('Pending approval metadata is inconsistent.');
    if (status === 'approved' && (!approvedAt || !approvalExpiresAt || consumedAt || deniedAt)) throw corrupt('Approved metadata is inconsistent.');
    if (status === 'consumed' && (!approvedAt || !approvalExpiresAt || !consumedAt || deniedAt)) throw corrupt('Consumed approval metadata is inconsistent.');
    if (status === 'denied' && (!deniedAt || consumedAt)) throw corrupt('Denied approval metadata is inconsistent.');
    if (approvedAt && Date.parse(approvedAt) < Date.parse(createdAt)) throw corrupt('Approval timestamp ordering is invalid.');
    if (approvalExpiresAt && (!approvedAt || Date.parse(approvalExpiresAt) <= Date.parse(approvedAt))) throw corrupt('Approval expiry ordering is invalid.');
    if (consumedAt && approvedAt && Date.parse(consumedAt) < Date.parse(approvedAt)) throw corrupt('Approval consumption ordering is invalid.');

    return {
      actionId, actionHash: actionHashValue, authorityHash, approvalRequestId,
      capability, risk: risk as ActionRequest['risk'], target, status: status as ApprovalStatus,
      createdAt, pendingExpiresAt, approvedAt, approvalExpiresAt, consumedAt, deniedAt
    } satisfies ApprovalRecord;
  });
  return { version: 2, records };
}
function validStoredText(value: unknown, max: number, label: string): string {
  const text = String(value ?? '');
  if (!text || text.length > max || /\0/.test(text)) throw corrupt(`Approval ${label} is invalid.`);
  return text;
}

function validIso(value: unknown, label: string): string {
  const text = String(value ?? '');
  const time = Date.parse(text);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== text) throw corrupt(`Approval ${label} is invalid.`);
  return text;
}

function validUuid(value: unknown, label: string): string {
  const text = String(value ?? '');
  if (!isUuid(text)) throw new OperatorError('APPROVAL_AUTHORITY_INVALID', `${label} must be a UUID.`);
  return text.toLowerCase();
}

function validGeneration(value: unknown): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new OperatorError('APPROVAL_AUTHORITY_INVALID', 'Approval authority generation is invalid.');
  return generation;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function corrupt(message: string): OperatorError {
  return new OperatorError('APPROVAL_STORE_CORRUPT', message);
}
