import crypto from 'node:crypto';
import path from 'node:path';
import type { ActionRequest, ActionResult } from '../../../src/core/types.ts';
import { actionHash, canonicalJson } from '../../../src/core/action-identity.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { readDurableStateText, writeDurableStateText } from '../../../src/core/durable-state.ts';
import { approvalAuthorityFingerprint, type ApprovalAuthorityContext } from './approval-store.ts';

const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS = 256;
const COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60_000;
const UNCERTAIN_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_RESULT_BYTES = 512 * 1024;

export type LocalActionExecutionRecord = {
  actionId: string;
  actionHash: string;
  authorityHash: string;
  risk: ActionRequest['risk'];
  status: 'processing' | 'completed';
  startedAt: string;
  ownerId?: string;
  completedAt?: string;
  resultSha256?: string;
  result?: ActionResult;
};

type State = { version: 1; records: LocalActionExecutionRecord[] };

export class LocalActionExecutionStore {
  #file: string;
  #clock: () => Date;
  #ownerId = crypto.randomUUID();
  #queue: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: { clock?: () => Date } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'action-executions.json');
    this.#clock = options.clock ?? (() => new Date());
  }

  async begin(action: ActionRequest, authority?: ApprovalAuthorityContext): Promise<
    | { status: 'started'; record: LocalActionExecutionRecord }
    | { status: 'processing'; record: LocalActionExecutionRecord }
    | { status: 'completed'; record: LocalActionExecutionRecord; result: ActionResult }
  > {
    const identity = executionIdentity(action, authority);
    return await this.#mutate((state) => {
      prune(state, this.#clock().getTime());
      const existing = state.records.find((entry) => entry.actionId === action.id);
      if (existing) {
        assertIdentity(existing, identity);
        if (existing.risk === 'read') {
          if (existing.status === 'processing' && existing.ownerId === this.#ownerId) {
            return { status: 'processing', record: clone(existing) };
          }
          existing.status = 'processing';
          existing.ownerId = this.#ownerId;
          existing.startedAt = this.#clock().toISOString();
          existing.completedAt = undefined;
          existing.resultSha256 = undefined;
          existing.result = undefined;
          return { status: 'started', record: clone(existing) };
        }
        if (existing.status === 'completed') return { status: 'completed', record: clone(existing), result: cloneResult(existing.result!) };
        return { status: 'processing', record: clone(existing) };
      }
      if (state.records.length >= MAX_RECORDS) {
        throw new OperatorError('ACTION_EXECUTION_STORE_FULL', 'Local action execution receipt store is full; resolve retained uncertain executions before starting more mutations.', { retryable: false });
      }
      const record: LocalActionExecutionRecord = {
        actionId: action.id,
        actionHash: identity.actionHash,
        authorityHash: identity.authorityHash,
        risk: action.risk,
        status: 'processing',
        startedAt: this.#clock().toISOString(),
        ownerId: this.#ownerId
      };
      state.records.push(record);
      return { status: 'started', record: clone(record) };
    });
  }

  async complete(action: ActionRequest, result: ActionResult, authority?: ApprovalAuthorityContext): Promise<LocalActionExecutionRecord> {
    const identity = executionIdentity(action, authority);
    const safeResult = validateResult(result);
    const resultText = JSON.stringify(safeResult);
    if (Buffer.byteLength(resultText, 'utf8') > MAX_RESULT_BYTES) {
      throw new OperatorError('ACTION_EXECUTION_RESULT_TOO_LARGE', 'Local action result exceeds the durable execution-receipt limit.', { retryable: false });
    }
    const resultSha256 = crypto.createHash('sha256').update(resultText, 'utf8').digest('hex');
    return await this.#mutate((state) => {
      prune(state, this.#clock().getTime());
      const record = state.records.find((entry) => entry.actionId === action.id);
      if (!record) throw new OperatorError('ACTION_EXECUTION_RECEIPT_MISSING', 'Local action execution receipt disappeared before completion.', { retryable: false });
      assertIdentity(record, identity);
      if (record.status === 'completed') {
        if (record.resultSha256 !== resultSha256) {
          throw new OperatorError('ACTION_EXECUTION_RESULT_CONFLICT', 'Completed local action execution receipt conflicts with a different result.', { retryable: false });
        }
        return clone(record);
      }
      record.status = 'completed';
      record.completedAt = this.#clock().toISOString();
      record.resultSha256 = resultSha256;
      record.result = safeResult;
      return clone(record);
    });
  }

  async lookup(action: ActionRequest, authority?: ApprovalAuthorityContext): Promise<
    | { status: 'missing' }
    | { status: 'processing'; record: LocalActionExecutionRecord }
    | { status: 'completed'; record: LocalActionExecutionRecord; result: ActionResult }
  > {
    const identity = executionIdentity(action, authority);
    return await this.#mutate((state) => {
      prune(state, this.#clock().getTime());
      const record = state.records.find((entry) => entry.actionId === action.id);
      if (!record) return { status: 'missing' };
      assertIdentity(record, identity);
      if (record.status === 'completed') return { status: 'completed', record: clone(record), result: cloneResult(record.result!) };
      return { status: 'processing', record: clone(record) };
    });
  }

  async #read(): Promise<State> {
    try {
      const text = await readDurableStateText(this.#file, {
        maxBytes: MAX_STATE_BYTES,
        errorCode: 'ACTION_EXECUTION_STATE_INVALID',
        invalidMessage: 'Local action execution receipt state is invalid.'
      });
      return validateState(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] };
      throw error;
    }
  }

  async #write(state: State): Promise<void> {
    await writeDurableStateText(this.#file, JSON.stringify(state), {
      maxBytes: MAX_STATE_BYTES,
      errorCode: 'ACTION_EXECUTION_STATE_INVALID',
      invalidMessage: 'Local action execution receipt state is invalid.'
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

function executionIdentity(action: ActionRequest, authority?: ApprovalAuthorityContext) {
  return {
    actionHash: actionHash(action),
    authorityHash: approvalAuthorityFingerprint(authority)
  };
}

function assertIdentity(record: LocalActionExecutionRecord, identity: { actionHash: string; authorityHash: string }): void {
  if (record.actionHash !== identity.actionHash) {
    throw new OperatorError('ACTION_EXECUTION_ACTION_MISMATCH', 'Action ID is already bound to different executable content.', { retryable: false });
  }
  if (record.authorityHash !== identity.authorityHash) {
    throw new OperatorError('ACTION_EXECUTION_AUTHORITY_MISMATCH', 'Action ID is already bound to different execution authority.', { retryable: false });
  }
}

function prune(state: State, now: number): void {
  state.records = state.records.filter((record) => {
    const anchor = record.completedAt ?? record.startedAt;
    const retention = record.status === 'completed' ? COMPLETED_RETENTION_MS : UNCERTAIN_RETENTION_MS;
    return Date.parse(anchor) > now - retention;
  });
}

function validateState(input: unknown): State {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt();
  const raw = input as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.records) || raw.records.length > MAX_RECORDS) throw corrupt();
  const ids = new Set<string>();
  const records = raw.records.map((value) => validateRecord(value, ids));
  return { version: 1, records };
}

function validateRecord(input: unknown, ids: Set<string>): LocalActionExecutionRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt();
  const raw = input as Record<string, unknown>;
  const actionId = validText(raw.actionId, 256);
  if (ids.has(actionId)) throw corrupt();
  ids.add(actionId);
  const actionHashValue = validSha(raw.actionHash);
  const authorityHash = validSha(raw.authorityHash);
  if (!['read','write','external','system','destructive'].includes(String(raw.risk))) throw corrupt();
  const status = String(raw.status);
  if (status !== 'processing' && status !== 'completed') throw corrupt();
  const startedAt = validIso(raw.startedAt);
  const ownerId = raw.ownerId === undefined ? undefined : validUuid(raw.ownerId);
  const completedAt = raw.completedAt === undefined ? undefined : validIso(raw.completedAt);
  const resultSha256 = raw.resultSha256 === undefined ? undefined : validSha(raw.resultSha256);
  const result = raw.result === undefined ? undefined : validateResult(raw.result);
  if (status === 'processing' && (completedAt || resultSha256 || result)) throw corrupt();
  if (status === 'completed' && (!completedAt || !resultSha256 || !result)) throw corrupt();
  if (completedAt && Date.parse(completedAt) < Date.parse(startedAt)) throw corrupt();
  if (result) {
    const actual = crypto.createHash('sha256').update(JSON.stringify(result), 'utf8').digest('hex');
    if (actual !== resultSha256) throw corrupt();
  }
  return {
    actionId, actionHash: actionHashValue, authorityHash,
    risk: raw.risk as ActionRequest['risk'], status, startedAt, ownerId,
    completedAt, resultSha256, result
  };
}

function validateResult(input: unknown): ActionResult {
  const text = JSON.stringify(input);
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) throw corrupt();
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt();
  const raw = value as Record<string, unknown>;
  if (typeof raw.ok !== 'boolean' || typeof raw.capability !== 'string' || raw.capability.length < 1 || raw.capability.length > 128) throw corrupt();
  if (typeof raw.provider !== 'string' || raw.provider.length < 1 || raw.provider.length > 256) throw corrupt();
  if (!Array.isArray(raw.evidence) || !Number.isFinite(raw.durationMs) || Number(raw.durationMs) < 0) throw corrupt();
  if (raw.error !== undefined && (!raw.error || typeof raw.error !== 'object' || Array.isArray(raw.error))) throw corrupt();
  return value as ActionResult;
}

function validText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.includes('\0')) throw corrupt();
  return value;
}
function validSha(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw corrupt();
  return value;
}
function validIso(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw corrupt();
  return value;
}
function validUuid(value: unknown): string {
  const text = String(value ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)) throw corrupt();
  return text;
}
function clone(record: LocalActionExecutionRecord): LocalActionExecutionRecord { return structuredClone(record); }
function cloneResult(result: ActionResult): ActionResult { return structuredClone(result); }
function corrupt(): OperatorError {
  return new OperatorError('ACTION_EXECUTION_STATE_INVALID', 'Local action execution receipt state is corrupt or inconsistent.', { retryable: false });
}
