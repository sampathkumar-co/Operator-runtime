import {
  buildApprovalCenterModel,
  buildGuidedOnboardingModel,
  buildRecoveryCenterModel,
  type ApprovalCenterModel,
  type GuidedOnboardingModel,
  type OnboardingStateInput,
  type RecoveryCenterModel,
  type RecoveryCandidateInput
} from '../../../src/core/control-center-ux.ts';
import type { TaskCapsule, TaskActionRecord } from '../../../src/core/task.ts';
import type { ApprovalRecord } from './approval-store.ts';

export interface ControlCenterProductSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  approvals: ApprovalCenterModel;
  recovery: RecoveryCenterModel;
  onboarding: GuidedOnboardingModel;
  health: {
    tasks: number;
    blockedTasks: number;
    uncertainActions: number;
    pendingApprovals: number;
  };
}

export function buildControlCenterProductSnapshot(input: {
  approvals: ApprovalRecord[];
  tasks: TaskCapsule[];
  onboarding: OnboardingStateInput;
  now?: string;
}): ControlCenterProductSnapshot {
  const now = input.now ?? new Date().toISOString();
  const approvals = buildApprovalCenterModel(input.approvals.map((record) => ({
    actionId: record.actionId,
    approvalRequestId: record.approvalRequestId,
    capability: record.capability,
    risk: record.risk,
    ...(record.target ? { target: record.target } : {}),
    status: record.status,
    createdAt: record.createdAt,
    pendingExpiresAt: record.pendingExpiresAt,
    ...(record.approvalExpiresAt ? { approvalExpiresAt: record.approvalExpiresAt } : {}),
    ...(record.consumedAt ? { consumedAt: record.consumedAt } : {}),
    ...(record.deniedAt ? { deniedAt: record.deniedAt } : {}),
    ...(record.executionLeaseId ? {
      executionLeaseId: record.executionLeaseId,
      executionLeaseExpiresAt: record.executionLeaseExpiresAt!
    } : {})
  })), now);

  const recoveryCandidates: RecoveryCandidateInput[] = [];
  for (const task of input.tasks) {
    const record = latestAction(task);
    if (!record) continue;
    if (!['FAILED','INTERRUPTED','BLOCKED'].includes(record.state) && record.sideEffectState !== 'uncertain') continue;
    const latestPlanner = [...(task.execution?.plannerEvents ?? [])].reverse()
      .find((event) => event.resourceContext.capability === record.capability);
    const sideEffectState = record.sideEffectState
      ?? (record.executionPhase === 'pre_dispatch' ? 'none' : 'uncertain');
    recoveryCandidates.push({
      actionId: record.actionId,
      capability: record.capability,
      retryable: latestPlanner?.retryAllowed === true,
      sideEffectState,
      ...(record.executionPhase ? { executionPhase: record.executionPhase } : {}),
      ...(sideEffectState === 'none' ? { reconciliationStatus: 'not_applied' as const } : {}),
      rollbackAvailable: false,
      verificationStatus: task.state === 'VERIFIED' ? 'passed' : task.state === 'FAILED' ? 'failed' : 'unknown',
      ...(record.errorCode ? { code: record.errorCode } : {}),
      updatedAt: record.finishedAt ?? task.updatedAt
    });
  }

  const recovery = buildRecoveryCenterModel(recoveryCandidates);
  const onboarding = buildGuidedOnboardingModel(input.onboarding);
  return {
    schemaVersion: 1,
    generatedAt: now,
    approvals,
    recovery,
    onboarding,
    health: {
      tasks: input.tasks.length,
      blockedTasks: input.tasks.filter((task) => task.state === 'BLOCKED').length,
      uncertainActions: recovery.items.filter((item) => item.disposition === 'UNCERTAIN').length,
      pendingApprovals: approvals.counts.pending
    }
  };
}

function latestAction(task: TaskCapsule): TaskActionRecord | undefined {
  return task.execution?.records?.at(-1);
}
