import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';
import { withDurableStateLock } from './durable-state-lock.ts';
import { appendDurableStateText, readDurableStateText } from './durable-state.ts';

export type OperationTraceStage =
  | 'REQUEST'
  | 'ROUTE'
  | 'PLAN'
  | 'POLICY'
  | 'APPROVAL'
  | 'LEASE'
  | 'DISPATCH'
  | 'RECONCILE'
  | 'VERIFY'
  | 'ARTIFACT'
  | 'COMPLETE';

export type OperationTraceOutcome = 'OK' | 'BLOCKED' | 'FAILED' | 'UNCERTAIN' | 'CANCELLED';

export interface OperationTraceEvent {
  schemaVersion: 1;
  id: string;
  traceId: string;
  parentEventId?: string;
  executionContextDigest: string;
  stage: OperationTraceStage;
  outcome: OperationTraceOutcome;
  code?: string;
  durationMs?: number;
  at: string;
  attributes: Record<string, string | number | boolean | null>;
}

const MAX_EVENT_BYTES = 32 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const STORE_OPTIONS = {
  maxBytes: MAX_FILE_BYTES,
  errorCode: 'OPERATION_TRACE_CORRUPT',
  invalidMessage: 'Operation trace state is invalid.'
} as const;
const DIGEST = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9._:@/+\-=]{1,256}$/;
const STAGES = new Set<OperationTraceStage>(['REQUEST','ROUTE','PLAN','POLICY','APPROVAL','LEASE','DISPATCH','RECONCILE','VERIFY','ARTIFACT','COMPLETE']);
const OUTCOMES = new Set<OperationTraceOutcome>(['OK','BLOCKED','FAILED','UNCERTAIN','CANCELLED']);

export class OperationTraceStore {
  #file: string;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.#file = path.join(path.resolve(stateDir), 'operation-traces.ndjson');
  }

  async append(input: Omit<OperationTraceEvent, 'schemaVersion' | 'id'> & { id?: string }): Promise<OperationTraceEvent> {
    const event = normalizeTraceEvent({
      schemaVersion: 1,
      ...input,
      id: input.id ?? eventId(input)
    });
    const line = JSON.stringify(event) + '\n';
    if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) {
      throw new OperatorError('OPERATION_TRACE_INVALID', 'Operation trace event exceeds bounded size.');
    }
    const run = this.#serial.then(() => withDurableStateLock(this.#file, async () => {
      await appendDurableStateText(this.#file, line, STORE_OPTIONS);
    }));
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
    return event;
  }

  async list(input: { traceId?: string; limit?: number } = {}): Promise<OperationTraceEvent[]> {
    await this.#serial;
    let text: string;
    try {
      text = await readDurableStateText(this.#file, STORE_OPTIONS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const limit = Math.min(Math.max(Number.isSafeInteger(input.limit) ? input.limit! : 500, 1), 5000);
    const traceId = input.traceId === undefined ? undefined : validId(input.traceId, 'traceId');
    const rows = text.split(/\r?\n/).filter(Boolean).map((line) => {
      try { return normalizeTraceEvent(JSON.parse(line)); }
      catch (error) {
        if (error instanceof OperatorError) throw error;
        throw new OperatorError('OPERATION_TRACE_CORRUPT', 'Operation trace contains invalid JSON.');
      }
    }).filter((event) => !traceId || event.traceId === traceId);
    return rows.slice(-limit);
  }
}

export function normalizeTraceEvent(input: unknown): OperationTraceEvent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Operation trace event must be an object.');
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== 1) throw invalid('Operation trace schemaVersion must be 1.');
  const id = validId(raw.id, 'id');
  const traceId = validId(raw.traceId, 'traceId');
  const parentEventId = raw.parentEventId === undefined ? undefined : validId(raw.parentEventId, 'parentEventId');
  const executionContextDigest = String(raw.executionContextDigest ?? '').toLowerCase();
  if (!DIGEST.test(executionContextDigest)) throw invalid('executionContextDigest is invalid.');
  if (!STAGES.has(raw.stage as OperationTraceStage)) throw invalid('stage is invalid.');
  if (!OUTCOMES.has(raw.outcome as OperationTraceOutcome)) throw invalid('outcome is invalid.');
  const code = raw.code === undefined ? undefined : validId(raw.code, 'code');
  let durationMs: number | undefined;
  if (raw.durationMs !== undefined) {
    durationMs = Number(raw.durationMs);
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 24 * 60 * 60_000) throw invalid('durationMs is invalid.');
  }
  const at = canonicalIso(raw.at, 'at');
  return {
    schemaVersion: 1,
    id,
    traceId,
    ...(parentEventId ? { parentEventId } : {}),
    executionContextDigest,
    stage: raw.stage as OperationTraceStage,
    outcome: raw.outcome as OperationTraceOutcome,
    ...(code ? { code } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    at,
    attributes: scalarAttributes(raw.attributes)
  };
}


export interface OperationTraceCoverageExpectation {
  requiresPlan?: boolean;
  requiresApproval?: boolean;
  requiresLease?: boolean;
  requiresReconciliation?: boolean;
  requiresArtifact?: boolean;
}

export interface OperationTraceCoverage {
  traceId: string;
  complete: boolean;
  requiredStages: OperationTraceStage[];
  missingStages: OperationTraceStage[];
  outOfOrderStages: OperationTraceStage[];
  terminalOutcome?: OperationTraceOutcome;
}

export function evaluateOperationTraceCoverage(
  eventsInput: OperationTraceEvent[],
  expectation: OperationTraceCoverageExpectation = {}
): OperationTraceCoverage {
  const events = eventsInput.map(normalizeTraceEvent);
  if (events.length < 1) throw invalid('Trace coverage requires at least one event.');
  const traceIds = new Set(events.map((event) => event.traceId));
  if (traceIds.size !== 1) throw invalid('Trace coverage can evaluate exactly one traceId at a time.');
  const requiredStages: OperationTraceStage[] = [
    'REQUEST',
    'ROUTE',
    ...(expectation.requiresPlan ? ['PLAN' as const] : []),
    'POLICY',
    ...(expectation.requiresApproval ? ['APPROVAL' as const] : []),
    ...(expectation.requiresLease ? ['LEASE' as const] : []),
    'DISPATCH',
    ...(expectation.requiresReconciliation ? ['RECONCILE' as const] : []),
    'VERIFY',
    ...(expectation.requiresArtifact ? ['ARTIFACT' as const] : []),
    'COMPLETE'
  ];
  const ordered = events.slice().sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
  const firstIndex = new Map<OperationTraceStage, number>();
  for (let i=0;i<ordered.length;i+=1) {
    const stage=ordered[i]!.stage;
    if (!firstIndex.has(stage)) firstIndex.set(stage,i);
  }
  const missingStages = requiredStages.filter((stage)=>!firstIndex.has(stage));
  const outOfOrderStages: OperationTraceStage[] = [];
  let prior=-1;
  for (const stage of requiredStages) {
    const index=firstIndex.get(stage);
    if (index===undefined) continue;
    if (index<prior) outOfOrderStages.push(stage);
    prior=Math.max(prior,index);
  }
  const terminal=[...ordered].reverse().find((event)=>event.stage==='COMPLETE');
  const verify=[...ordered].reverse().find((event)=>event.stage==='VERIFY');
  if (terminal?.outcome==='OK' && verify?.outcome!=='OK' && !missingStages.includes('VERIFY')) {
    outOfOrderStages.push('VERIFY');
  }
  return {
    traceId: ordered[0]!.traceId,
    complete: missingStages.length===0 && outOfOrderStages.length===0,
    requiredStages,
    missingStages,
    outOfOrderStages:[...new Set(outOfOrderStages)],
    ...(terminal ? { terminalOutcome: terminal.outcome } : {})
  };
}

export interface OperationSloSummary {
  traces: number;
  completed: number;
  blocked: number;
  failed: number;
  uncertain: number;
  verified: number;
  completionRate: number;
  verificationRate: number;
  falseCompletionCount: number;
  p50CompletionMs: number;
  p95CompletionMs: number;
}

export function summarizeOperationSlo(eventsInput: OperationTraceEvent[]): OperationSloSummary {
  const events = eventsInput.map(normalizeTraceEvent);
  const byTrace = new Map<string, OperationTraceEvent[]>();
  for (const event of events) {
    const bucket = byTrace.get(event.traceId) ?? [];
    bucket.push(event);
    byTrace.set(event.traceId, bucket);
  }
  let completed = 0, blocked = 0, failed = 0, uncertain = 0, verified = 0, falseCompletionCount = 0;
  const completionMs: number[] = [];
  for (const rows of byTrace.values()) {
    rows.sort((a,b) => a.at.localeCompare(b.at));
    const complete = [...rows].reverse().find((event) => event.stage === 'COMPLETE');
    const verify = [...rows].reverse().find((event) => event.stage === 'VERIFY');
    if (complete?.outcome === 'OK') completed += 1;
    if (rows.some((event) => event.outcome === 'BLOCKED')) blocked += 1;
    if (rows.some((event) => event.outcome === 'FAILED')) failed += 1;
    if (rows.some((event) => event.outcome === 'UNCERTAIN')) uncertain += 1;
    if (verify?.outcome === 'OK') verified += 1;
    if (complete?.outcome === 'OK' && verify?.outcome !== 'OK') falseCompletionCount += 1;
    if (complete) completionMs.push(Math.max(0, Date.parse(complete.at) - Date.parse(rows[0]!.at)));
  }
  const traces = byTrace.size;
  completionMs.sort((a,b)=>a-b);
  return {
    traces,
    completed,
    blocked,
    failed,
    uncertain,
    verified,
    completionRate: ratio(completed, traces),
    verificationRate: ratio(verified, traces),
    falseCompletionCount,
    p50CompletionMs: percentile(completionMs, 0.5),
    p95CompletionMs: percentile(completionMs, 0.95)
  };
}

function eventId(input: Omit<OperationTraceEvent, 'schemaVersion' | 'id'>): string {
  return crypto.createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex');
}

function scalarAttributes(input: unknown): Record<string, string | number | boolean | null> {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('attributes must be an object.');
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 64) throw invalid('attributes exceed the bounded entry count.');
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of entries.sort(([a],[b])=>a.localeCompare(b))) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw invalid('attribute key is invalid.');
    if (value !== null && !['string','number','boolean'].includes(typeof value)) throw invalid('attribute value is invalid.');
    if (typeof value === 'string' && Buffer.byteLength(value,'utf8') > 1024) throw invalid('attribute string is too large.');
    if (typeof value === 'number' && !Number.isFinite(value)) throw invalid('attribute number is invalid.');
    out[key] = value as string | number | boolean | null;
  }
  return out;
}

function validId(input: unknown, label: string): string {
  if (typeof input !== 'string' || !ID.test(input)) throw invalid(`${label} is invalid.`);
  return input;
}
function canonicalIso(input: unknown, label: string): string {
  const text=String(input??'');
  if(!text || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString()!==text) throw invalid(`${label} must be canonical ISO.`);
  return text;
}
function ratio(n: number, d: number): number { return d === 0 ? 0 : n / d; }
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1));
  return values[index]!;
}
function invalid(message:string):OperatorError{return new OperatorError('OPERATION_TRACE_INVALID',message);}
