import crypto from 'node:crypto';
import type { RuntimeControlProjection } from './runtime-projection.ts';
import type { Evidence, EvidenceStatus } from './types.ts';
import type { TaskActionRecord, TaskCapsule } from './task.ts';

export type ControlCenterRecoveryState = 'NONE' | 'APPROVAL_REQUIRED' | 'RECONCILE_REQUIRED' | 'ESCALATION_REQUIRED';

export interface ControlCenterTaskTimeline {
  schemaVersion: 1;
  task: { id: string; objective: string; state: TaskCapsule['state']; createdAt: string; updatedAt: string };
  planning: {
    plannerId: string;
    modelIdentity: { status: 'NOT_RECORDED'; reason: string };
  };
  cost: {
    reserved: { calls: number; tokens: number; ceilingMicros: number };
    actual: { status: 'NOT_RECORDED'; costMicros: null; inputTokens: null; outputTokens: null; reason: string };
  };
  verification: RuntimeControlProjection['verification'];
  recovery: { state: ControlCenterRecoveryState; code?: string; guidance: string };
  evidence: { total: number; classified: number; pass: number; fail: number; info: number; truncated: boolean };
  timeline: ControlCenterTaskTimelineEvent[];
  truncated: boolean;
  page: { nextBefore: number | null; totalEvents: number; limit: number; snapshot: string };
}

export interface ControlCenterTaskTimelineEvent {
  id: string;
  kind: 'TASK_CREATED' | 'ACTION' | 'TASK_FAILURE';
  at: string;
  finishedAt?: string;
  title: string;
  state: string;
  attempt?: number;
  risk?: string;
  provider?: string;
  observation?: { channel: string; domain: string; at: string; epistemicStatus?: string };
  error?: { code: string; message?: string; executionPhase?: string; sideEffectState?: string };
  evidence: Array<{ kind: string; status: EvidenceStatus; message: string; timestamp: string }>;
}

const MAX_EVENTS = 500;
const MAX_EVENT_EVIDENCE = 50;
const MAX_CLASSIFIED_EVIDENCE = 100_000;

export function buildControlCenterTaskTimeline(
  task: TaskCapsule,
  projection: RuntimeControlProjection,
  options: { before?: number; limit?: number; snapshot?: string } = {}
): ControlCenterTaskTimeline {
  const execution = task.execution;
  const records = execution?.records ?? [];
  const limit = options.limit ?? MAX_EVENTS;
  const totalEvents = records.length + task.failures.length;
  const before = options.before ?? totalEvents;
  // A cursor is a position within a stable, chronological snapshot. Do not
  // quietly clamp stale/fractional caller cursors to a different history page.
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENTS ||
      !Number.isSafeInteger(before) || before < 0 || before > totalEvents ||
      (options.before !== undefined && before === 0)) {
    throw new Error('TASK_TIMELINE_CURSOR_INVALID');
  }
  // Sort lightweight keys, not fully projected actions with up to 50 pieces
  // of evidence each. Only the requested page becomes user-visible objects.
  const refs: Array<{ kind: 'action' | 'failure'; index: number; at: string; order: number }> = [
    ...records.map((record, index) => ({ kind: 'action' as const, index, at: record.startedAt, order: index })),
    ...task.failures.map((failure, index) => ({
      kind: 'failure' as const, index, at: failure.at, order: records.length + index
    }))
  ];
  refs.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
  // Pagination must not silently change meaning while task records are being
  // appended or revised. Bind all pages to the same exact history snapshot.
  const historyHash = crypto.createHash('sha256').update(task.id).update('\0')
    .update(task.updatedAt).update('\0').update(task.state);
  // A timeline entry can be reconciled or independently verified *in place*
  // without a new actionId/start time (and older snapshots may have been
  // paged already). Hash the exact displayed state and evidence, not just
  // event ordering, so stale cursors fail closed instead of mixing revisions.
  // Hash incrementally to avoid building or retaining a second giant history.
  for (const ref of refs) {
    historyHash.update('\0').update(ref.kind).update(':').update(ref.at);
    if (ref.kind === 'failure') {
      const failure = task.failures[ref.index]!;
      historyHash.update(JSON.stringify([ref.index, failure.code, bounded(failure.message, 1024)]));
      continue;
    }
    const record = records[ref.index]!;
    const observation = record.observation;
    historyHash.update(JSON.stringify([
      record.actionId, record.capability, record.state, record.attempt, record.risk,
      record.finishedAt ?? null, record.errorCode ?? null,
      record.executionPhase ?? null, record.sideEffectState ?? null,
      observation?.provider ?? null, observation?.channel ?? null,
      observation?.domain ?? null, observation?.observedAt ?? null,
      observation?.schemaVersion === 2 ? observation.epistemicStatus : null,
      record.evidence.length
    ]));
    for (const item of record.evidence) {
      historyHash.update('\0').update(JSON.stringify([
        bounded(item.kind, 256), item.status, bounded(item.message, 1024),
        item.timestamp
      ]));
    }
  }
  // Aggregate evidence is also part of the returned timeline projection.
  historyHash.update('\0').update(String(task.evidence.length));
  for (const item of task.evidence) {
    historyHash.update('\0').update(JSON.stringify([
      bounded(item.kind, 256), item.status, bounded(item.message, 1024),
      item.timestamp
    ]));
  }
  const snapshot = historyHash.digest('hex');
  if (options.before !== undefined && options.snapshot !== snapshot) {
    throw new Error('TASK_TIMELINE_SNAPSHOT_STALE');
  }
  const start = Math.max(0, before - limit);
  const visibleEvents = refs.slice(start, before).map((ref): ControlCenterTaskTimelineEvent => {
    if (ref.kind === 'action') return actionEvent(records[ref.index]!);
    const failure = task.failures[ref.index]!;
    return {
      id: `failure:${ref.index}:${bounded(failure.code, 256)}`,
      kind: 'TASK_FAILURE',
      at: failure.at,
      title: 'Task failure',
      state: 'FAILED',
      error: { code: bounded(failure.code, 256), message: bounded(failure.message, 1024) },
      evidence: []
    };
  });
  const taskEvidence = evidenceSummary(task.evidence, records);
  const recovery = recoveryProjection(task, projection, records);

  return {
    schemaVersion: 1,
    task: {
      id: bounded(task.id, 128),
      objective: bounded(task.userObjective, 1024),
      state: task.state,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    },
    planning: {
      plannerId: bounded(execution?.plannerId ?? 'not-started', 256),
      modelIdentity: {
        status: 'NOT_RECORDED',
        reason: 'This task contract records the planner identity, but not a trustworthy model identifier.'
      }
    },
    cost: {
      reserved: {
        calls: safeCount(execution?.modelCallCount),
        tokens: safeCount(execution?.modelReservedTokens),
        ceilingMicros: safeCount(execution?.modelReservedCostMicros)
      },
      actual: {
        status: 'NOT_RECORDED',
        costMicros: null,
        inputTokens: null,
        outputTokens: null,
        reason: 'Reservations are safety ceilings, not provider billing. Actual token and cost settlement is not present in this task record.'
      }
    },
    verification: projection.verification,
    recovery,
    evidence: taskEvidence,
    // The initial task-created marker is already present in the active view;
    // older pages only contribute the requested historical events.
    timeline: options.before === undefined ? [createdEvent(task), ...visibleEvents] : visibleEvents,
    truncated: start > 0,
    page: { nextBefore: start > 0 ? start : null, totalEvents, limit, snapshot }
  };
}

function createdEvent(task: TaskCapsule): ControlCenterTaskTimelineEvent {
  return {
    id: `task:${bounded(task.id, 128)}`,
    kind: 'TASK_CREATED',
    at: task.createdAt,
    title: 'Task created',
    state: 'PENDING',
    evidence: []
  };
}

function actionEvent(record: TaskActionRecord): ControlCenterTaskTimelineEvent {
  const observation = record.observation;
  return {
    id: bounded(record.actionId, 512),
    kind: 'ACTION',
    at: record.startedAt,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    title: bounded(record.capability, 256),
    state: record.state,
    attempt: record.attempt,
    risk: record.risk,
    ...(observation?.provider ? { provider: bounded(observation.provider, 256) } : {}),
    ...(observation ? { observation: {
      channel: observation.channel,
      domain: observation.domain,
      at: observation.observedAt,
      ...(observation.schemaVersion === 2 ? { epistemicStatus: observation.epistemicStatus } : {})
    } } : {}),
    ...(record.errorCode ? { error: {
      code: bounded(record.errorCode, 256),
      ...(record.executionPhase ? { executionPhase: record.executionPhase } : {}),
      ...(record.sideEffectState ? { sideEffectState: record.sideEffectState } : {})
    } } : {}),
    evidence: record.evidence.slice(-MAX_EVENT_EVIDENCE).map(projectEvidence)
  };
}

function recoveryProjection(
  task: TaskCapsule,
  projection: RuntimeControlProjection,
  records: TaskActionRecord[]
): ControlCenterTaskTimeline['recovery'] {
  if (projection.reconciliationRequired) {
    return {
      state: 'RECONCILE_REQUIRED',
      code: projection.blocker?.code ?? 'ACTION_RECONCILIATION_REQUIRED',
      guidance: 'A side effect remains uncertain. Do not retry it; use the separately authorized reconciliation path.'
    };
  }
  if (projection.pendingApproval || records.at(-1)?.errorCode === 'APPROVAL_REQUIRED') {
    return {
      state: 'APPROVAL_REQUIRED',
      code: 'APPROVAL_REQUIRED',
      guidance: 'Review the effect in the trusted local approval surface. This timeline cannot grant approval.'
    };
  }
  if (task.state === 'FAILED' || task.state === 'BLOCKED') {
    return {
      state: 'ESCALATION_REQUIRED',
      ...(projection.blocker?.code ? { code: bounded(projection.blocker.code, 256) } : {}),
      guidance: 'No retry authority is recorded. Inspect the error and recovery center before choosing a next action.'
    };
  }
  return { state: 'NONE', guidance: 'No unresolved recovery requirement is recorded for this task.' };
}

function evidenceSummary(taskEvidence: Evidence[], records: TaskActionRecord[]): ControlCenterTaskTimeline['evidence'] {
  const total = taskEvidence.length + records.reduce((count, record) => count + record.evidence.length, 0);
  const summary = { total, classified: 0, pass: 0, fail: 0, info: 0, truncated: total > MAX_CLASSIFIED_EVIDENCE };
  const groups: Iterable<Evidence[]> = (function* () {
    yield taskEvidence;
    for (const record of records) yield record.evidence;
  })();
  for (const items of groups) {
    for (const item of items) {
      if (summary.classified >= MAX_CLASSIFIED_EVIDENCE) return summary;
      summary.classified += 1;
      summary[item.status] += 1;
    }
  }
  return summary;
}

function projectEvidence(item: Evidence): ControlCenterTaskTimelineEvent['evidence'][number] {
  return {
    kind: bounded(item.kind, 256),
    status: item.status,
    message: bounded(item.message, 1024),
    timestamp: item.timestamp
  };
}

function safeCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function bounded(value: string, max: number): string {
  return String(value ?? '').slice(0, max).replace(/[\r\n\0]/g, ' ');
}
