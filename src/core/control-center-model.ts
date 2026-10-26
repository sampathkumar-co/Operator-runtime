import type { DeveloperSession, DeveloperSessionStatus } from './developer-session.ts';
import { OperatorError } from './errors.ts';

export type ControlCenterAttention =
  | 'NONE'
  | 'APPROVAL_REQUIRED'
  | 'RECOVERY_REQUIRED'
  | 'VERIFICATION_REQUIRED'
  | 'BLOCKED'
  | 'FAILED';

export interface ControlCenterSessionSummary {
  id: string;
  objective: string;
  status: DeveloperSessionStatus;
  attention: ControlCenterAttention;
  artifactCount: number;
  taskCount: number;
  updatedAt: string;
  resumeSummary?: string;
}

export interface ControlCenterHomeModel {
  schemaVersion: 1;
  activeSessions: ControlCenterSessionSummary[];
  completedSessions: ControlCenterSessionSummary[];
  blockers: ControlCenterSessionSummary[];
  counts: {
    active: number;
    blocked: number;
    verifying: number;
    completed: number;
    failed: number;
  };
}

export function buildControlCenterHomeModel(
  sessionsInput: DeveloperSession[],
  attentionBySession: Readonly<Record<string, ControlCenterAttention>> = {}
): ControlCenterHomeModel {
  if (!Array.isArray(sessionsInput) || sessionsInput.length > 10_000 ||
      !attentionBySession || typeof attentionBySession !== 'object' || Array.isArray(attentionBySession)) {
    throw new OperatorError('CONTROL_CENTER_MODEL_INVALID', 'Developer Session collection or attention hints are invalid.');
  }
  const sessions = sessionsInput.map((session) => summarize(session, resolveAttention(session, attentionBySession)));
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const terminal = new Set<DeveloperSessionStatus>(['COMPLETED', 'FAILED', 'CANCELLED']);
  const activeSessions = sessions.filter((item) => !terminal.has(item.status));
  const completedSessions = sessions.filter((item) => terminal.has(item.status));
  const blockers = sessions.filter((item) => item.attention !== 'NONE');

  return {
    schemaVersion: 1,
    activeSessions,
    completedSessions,
    blockers,
    counts: {
      active: activeSessions.length,
      blocked: sessions.filter((item) => item.status === 'BLOCKED').length,
      verifying: sessions.filter((item) => item.status === 'VERIFYING').length,
      completed: sessions.filter((item) => item.status === 'COMPLETED').length,
      failed: sessions.filter((item) => item.status === 'FAILED').length
    }
  };
}

function summarize(session: DeveloperSession, attention: ControlCenterAttention): ControlCenterSessionSummary {
  if (!session || session.schemaVersion !== 1) throw new OperatorError('CONTROL_CENTER_MODEL_INVALID', 'Developer Session is invalid.');
  return {
    id: session.id,
    objective: session.objective,
    status: session.status,
    attention,
    artifactCount: session.artifactIds.length,
    taskCount: session.taskIds.length,
    updatedAt: session.updatedAt,
    ...(session.resumeSummary ? { resumeSummary: session.resumeSummary } : {})
  };
}

const ATTENTION_VALUES = new Set<ControlCenterAttention>([
  'NONE', 'APPROVAL_REQUIRED', 'RECOVERY_REQUIRED', 'VERIFICATION_REQUIRED', 'BLOCKED', 'FAILED'
]);

function resolveAttention(
  session: DeveloperSession,
  hints: Readonly<Record<string, ControlCenterAttention>>
): ControlCenterAttention {
  if (!session || session.schemaVersion !== 1 || typeof session.id !== 'string') {
    throw new OperatorError('CONTROL_CENTER_MODEL_INVALID', 'Developer Session identity is invalid.');
  }
  // Never use inherited Object keys such as "__proto__" as session hints.
  const hinted = Object.hasOwn(hints, session.id) ? hints[session.id] : undefined;
  if (hinted !== undefined && !ATTENTION_VALUES.has(hinted)) {
    throw new OperatorError('CONTROL_CENTER_MODEL_INVALID', 'Developer Session attention is invalid.');
  }
  const actual = attentionForStatus(session.status);
  // An out-of-date optional UI hint cannot clear a persisted failure,
  // block or pending verification. Preserve more-specific non-NONE hints.
  return actual !== 'NONE' && (hinted === undefined || hinted === 'NONE')
    ? actual : hinted ?? actual;
}

function attentionForStatus(status: DeveloperSessionStatus): ControlCenterAttention {
  if (status === 'BLOCKED') return 'BLOCKED';
  if (status === 'FAILED') return 'FAILED';
  if (status === 'VERIFYING') return 'VERIFICATION_REQUIRED';
  return 'NONE';
}
