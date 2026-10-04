import type { ActionJournalEntry } from './action-transition-journal.ts';
import type { TaskCapsule } from './task.ts';

type ApprovalProjectionInput = {
  actionId: string; approvalRequestId: string; capability: string; risk: string;
  status: string; pendingExpiresAt: string;
};

export interface RuntimeControlProjection {
  version: 1;
  active: { kind: 'task'; id: string; objective: string; state: TaskCapsule['state']; updatedAt: string };
  intent?: { conversationId: string; version: number; digest: string };
  pendingApproval?: { actionId: string; approvalRequestId: string; capability: string; risk: string; expiresAt: string };
  currentAction?: { actionId: string; capability: string; risk: string; state: string; executionPhase?: string; sideEffectState?: string; errorCode?: string };
  resources: string[];
  provider?: string;
  lastObservation?: { domain: string; channel: string; observedAt: string; stateVersion?: string; confidence?: number };
  verification: { state: 'pending' | 'verified' | 'failed'; digest?: string };
  reconciliationRequired: boolean;
  compensation: { state: 'none' | 'pending' | 'blocked' };
  blocker?: { code: string; reason: string };
}

export function projectTaskRuntime(
  task: TaskCapsule,
  options: { journal?: ActionJournalEntry[]; approvals?: ApprovalProjectionInput[] } = {}
): RuntimeControlProjection {
  const records = task.execution?.records ?? [];
  const current = [...records].reverse().find((record) => record.state === 'STARTED' || record.state === 'BLOCKED') ?? records.at(-1);
  const journal = current ? options.journal?.find((entry) => entry.actionId === current.actionId) : undefined;
  const approval = current ? options.approvals?.find((entry) => entry.actionId === current.actionId && entry.status === 'pending') : undefined;
  const provider = journal ? [...journal.transitions].reverse().find((transition) => transition.provider)?.provider : current?.observation?.provider;
  const observation = [...records].reverse().find((record) => record.observation)?.observation;
  const verificationEvidence = [...task.evidence].reverse().find((item) => item.kind.includes('verification'));
  const verificationDigest = typeof verificationEvidence?.data?.digest === 'string' && /^[0-9a-f]{64}$/i.test(verificationEvidence.data.digest)
    ? verificationEvidence.data.digest.toLowerCase() : undefined;
  const lastFailure = task.failures.at(-1);
  const reconciliationRequired = journal?.state === 'UNCERTAIN'
    || (task.execution?.plannerEvents ?? []).some((event) => event.decision === 'RECONCILE')
    || current?.sideEffectState === 'uncertain';
  const blocker = task.state === 'BLOCKED' || task.state === 'FAILED' || reconciliationRequired
    ? {
        code: reconciliationRequired ? 'ACTION_RECONCILIATION_REQUIRED' : lastFailure?.code ?? current?.errorCode ?? task.state,
        reason: bounded(lastFailure?.message ?? current?.errorCode ?? (reconciliationRequired ? 'A mutation effect remains uncertain.' : task.state), 1024)
      }
    : undefined;
  return {
    version: 1,
    active: { kind: 'task', id: task.id, objective: bounded(task.userObjective, 1024), state: task.state, updatedAt: task.updatedAt },
    ...(task.intent ? { intent: { conversationId: bounded(task.intent.conversationId, 256), version: task.intent.intentVersion, digest: task.intent.digest } } : {}),
    ...(approval ? { pendingApproval: {
      actionId: approval.actionId, approvalRequestId: approval.approvalRequestId,
      capability: approval.capability, risk: approval.risk, expiresAt: approval.pendingExpiresAt
    } } : {}),
    ...(current ? { currentAction: {
      actionId: bounded(current.actionId, 512), capability: bounded(current.capability, 256), risk: current.risk,
      state: current.state, ...(current.executionPhase ? { executionPhase: current.executionPhase } : {}),
      ...(current.sideEffectState ? { sideEffectState: current.sideEffectState } : {}),
      ...(current.errorCode ? { errorCode: bounded(current.errorCode, 256) } : {})
    } } : {}),
    resources: (journal?.resourceKeys ?? []).slice(0, 100).map((item) => bounded(item, 1024)),
    ...(provider ? { provider: bounded(provider, 256) } : {}),
    ...(observation ? { lastObservation: {
      domain: observation.domain, channel: observation.channel, observedAt: observation.observedAt,
      ...(observation.schemaVersion === 2 ? { stateVersion: observation.stateVersion, confidence: observation.confidence } : {})
    } } : {}),
    verification: {
      state: task.state === 'VERIFIED' && verificationEvidence?.status === 'pass' ? 'verified'
        : task.state === 'FAILED' || verificationEvidence?.status === 'fail' ? 'failed' : 'pending',
      ...(verificationDigest ? { digest: verificationDigest } : {})
    },
    reconciliationRequired,
    compensation: { state: 'none' },
    ...(blocker ? { blocker } : {})
  };
}

function bounded(input: string, max: number): string {
  return String(input ?? '').slice(0, max).replace(/[\r\n\0]/g, ' ');
}
