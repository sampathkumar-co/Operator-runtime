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
  if (typeof raw.executionContextDigest !== 'string') throw invalid('executionContextDigest must be an exact string.');
  const executionContextDigest = raw.executionContextDigest.toLowerCase();
  if (!DIGEST.test(executionContextDigest)) throw invalid('executionContextDigest is invalid.');
  if (!STAGES.has(raw.stage as OperationTraceStage)) throw invalid('stage is invalid.');
  if (!OUTCOMES.has(raw.outcome as OperationTraceOutcome)) throw invalid('outcome is invalid.');
  const code = raw.code === undefined ? undefined : validId(raw.code, 'code');
  let durationMs: number | undefined;
  if (raw.durationMs !== undefined) {
    if (typeof raw.durationMs !== 'number') throw invalid('durationMs must be an exact number.');
    durationMs = raw.durationMs;
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
  /** Invalid or cross-context lineage cannot certify stage coverage. */
  invalidCausalTrace: boolean;
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
  const requests = ordered.filter((event) => event.stage === 'REQUEST');
  const terminals = ordered.filter((event) => event.stage === 'COMPLETE');
  const invalidCausalTrace = requests.length !== 1 || terminals.length > 1
    || ordered[0] !== requests[0] || (terminals.length === 1 && ordered.at(-1) !== terminals[0])
    || ordered.some((event) => event.executionContextDigest !== ordered[0]!.executionContextDigest)
    || new Set(ordered.map((event) => event.id)).size !== ordered.length;
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
  const lastDispatch=[...ordered].reverse().find((event)=>event.stage==='DISPATCH');
  // An earlier successful verification cannot prove the final state of an
  // operation if a later dispatch might have changed it. Coverage must agree
  // with the independent SLO verifier, not merely first-seen stage ordering.
  if (terminal?.outcome==='OK' && !missingStages.includes('VERIFY')) {
    const freshProof = verify?.outcome==='OK'
      && Date.parse(verify.at) < Date.parse(terminal.at)
      && (!lastDispatch || Date.parse(lastDispatch.at) < Date.parse(verify.at));
    if (!freshProof) outOfOrderStages.push('VERIFY');
  }
  return {
    traceId: ordered[0]!.traceId,
    complete: !invalidCausalTrace && missingStages.length===0 && outOfOrderStages.length===0,
    requiredStages,
    missingStages,
    outOfOrderStages:[...new Set(outOfOrderStages)],
    invalidCausalTrace,
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
  /** Traces with duplicate, missing or cross-context request/terminal lineage. */
  invalidCausalTraces: number;
  /** Active traces without a terminal event never enter latency percentiles. */
  incompleteTraces: number;
  p50CompletionMs: number;
  p95CompletionMs: number;
  p99CompletionMs: number;
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
  let invalidCausalTraces = 0, incompleteTraces = 0;
  const completionMs: number[] = [];
  for (const rows of byTrace.values()) {
    rows.sort((a,b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    const requests = rows.filter((event) => event.stage === 'REQUEST');
    const terminals = rows.filter((event) => event.stage === 'COMPLETE');
    const complete = terminals.at(-1);
    // Only unique, same-scope, causally ordered request lineage contributes to
    // trusted verified-success and p50/p95/p99 latency sample denominators.
    // Retain raw terminal claims separately for false-completion accounting.
    const causal = requests.length === 1 && terminals.length === 1 && complete !== undefined
      && rows[0] === requests[0] && rows[rows.length - 1] === complete
      && Date.parse(requests[0]!.at) < Date.parse(complete.at)
      && rows.every((event) => event.executionContextDigest === rows[0]!.executionContextDigest)
      && new Set(rows.map((event) => event.id)).size === rows.length;
    if (!causal && complete) invalidCausalTraces += 1;
    if (!complete) incompleteTraces += 1;
    const verify = [...rows].reverse().find((event) => event.stage === 'VERIFY');
    const lastDispatch = [...rows].reverse().find((event) => event.stage === 'DISPATCH');
    // Positive verification must be causally newer than the last attempted
    // dispatch. A second side effect after a valid read supersedes its proof,
    // even if COMPLETE claims success.
    const verifiedBeforeCompletion = Boolean(causal && complete?.outcome === 'OK' && verify?.outcome === 'OK'
      && Date.parse(verify.at) < Date.parse(complete.at)
      && lastDispatch !== undefined && Date.parse(lastDispatch.at) < Date.parse(verify.at));
    if (complete?.outcome === 'OK') completed += 1;
    if (rows.some((event) => event.outcome === 'BLOCKED')) blocked += 1;
    if (rows.some((event) => event.outcome === 'FAILED')) failed += 1;
    if (rows.some((event) => event.outcome === 'UNCERTAIN')) uncertain += 1;
    if (verifiedBeforeCompletion) verified += 1;
    if (complete?.outcome === 'OK' && !verifiedBeforeCompletion) falseCompletionCount += 1;
    if (causal) completionMs.push(Date.parse(complete!.at) - Date.parse(requests[0]!.at));
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
    invalidCausalTraces,
    incompleteTraces,
    p50CompletionMs: percentile(completionMs, 0.5),
    p95CompletionMs: percentile(completionMs, 0.95),
    p99CompletionMs: percentile(completionMs, 0.99)
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
  if (typeof input !== 'string') throw invalid(`${label} must be a canonical ISO string.`);
  const text=input;
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
