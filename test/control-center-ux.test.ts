import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildApprovalCenterModel,
  buildGuidedOnboardingModel,
  buildRecoveryCenterModel
} from '../src/core/control-center-ux.ts';

const NOW = '2026-10-06T12:00:00.000Z';

test('Approval Center distinguishes pending, approved, in-use and expired authority', () => {
  const model = buildApprovalCenterModel([
    {
      actionId: 'pending-action',
      approvalRequestId: 'request-pending',
      capability: 'file.replace',
      risk: 'destructive',
      target: '/workspace/a.ts',
      status: 'pending',
      createdAt: '2026-10-06T11:59:00.000Z',
      pendingExpiresAt: '2026-10-06T12:05:00.000Z'
    },
    {
      actionId: 'approved-action',
      approvalRequestId: 'request-approved',
      capability: 'docker.manage',
      risk: 'system',
      status: 'approved',
      createdAt: '2026-10-06T11:58:00.000Z',
      pendingExpiresAt: '2026-10-06T12:01:00.000Z',
      approvalExpiresAt: '2026-10-06T12:08:00.000Z'
    },
    {
      actionId: 'in-use-action',
      approvalRequestId: 'request-in-use',
      capability: 'terminal.session',
      risk: 'destructive',
      status: 'approved',
      createdAt: '2026-10-06T11:57:00.000Z',
      pendingExpiresAt: '2026-10-06T12:00:30.000Z',
      approvalExpiresAt: '2026-10-06T12:07:00.000Z',
      executionLeaseId: 'lease-in-use',
      executionLeaseExpiresAt: '2026-10-06T12:01:00.000Z'
    },
    {
      actionId: 'expired-action',
      approvalRequestId: 'request-expired',
      capability: 'git.write',
      risk: 'write',
      status: 'approved',
      createdAt: '2026-10-06T11:40:00.000Z',
      pendingExpiresAt: '2026-10-06T11:45:00.000Z',
      approvalExpiresAt: '2026-10-06T11:55:00.000Z'
    }
  ], NOW);

  assert.equal(model.counts.pending, 1);
  assert.equal(model.counts.approved, 1);
  assert.equal(model.counts.inUse, 1);
  assert.equal(model.counts.expired, 1);

  const pending = model.pending[0]!;
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.canApprove, true);
  assert.equal(pending.canDeny, true);
  assert.equal(pending.effectClass, 'DESTRUCTIVE_EFFECT');
  assert.equal(pending.reversibility, 'MAY_BE_IRREVERSIBLE');
  assert.equal(pending.secondsRemaining, 300);

  const inUse = model.active.find((item) => item.actionId === 'in-use-action')!;
  assert.equal(inUse.status, 'IN_USE');
  assert.equal(inUse.executing, true);
  assert.equal(inUse.canDeny, false);
  assert.equal(inUse.canApprove, false);
});

test('uncertain side effects never expose automatic retry', () => {
  const model = buildRecoveryCenterModel([{
    actionId: 'a1',
    capability: 'file.replace',
    retryable: true,
    sideEffectState: 'uncertain',
    executionPhase: 'dispatched',
    updatedAt: NOW
  }]);
  assert.equal(model.items[0]?.disposition, 'UNCERTAIN');
  assert.equal(model.items[0]?.recommendedAction, 'RECONCILE');
  assert.equal(model.items[0]?.requiresFreshApproval, false);
});

test('uncertainty after reconciliation escalates instead of retrying', () => {
  const model = buildRecoveryCenterModel([{
    actionId: 'a2',
    capability: 'external.publish',
    retryable: true,
    sideEffectState: 'uncertain',
    reconciliationStatus: 'uncertain',
    updatedAt: NOW
  }]);
  assert.equal(model.items[0]?.recommendedAction, 'ESCALATE');
  assert.equal(model.items[0]?.disposition, 'UNCERTAIN');
});

test('proven not-applied retryable action can offer fresh-authority retry', () => {
  const model = buildRecoveryCenterModel([{
    actionId: 'a3',
    capability: 'git.write',
    retryable: true,
    sideEffectState: 'none',
    reconciliationStatus: 'not_applied',
    updatedAt: NOW
  }]);
  assert.equal(model.items[0]?.disposition, 'RETRYABLE');
  assert.equal(model.items[0]?.recommendedAction, 'RETRY');
  assert.equal(model.items[0]?.requiresFreshApproval, true);
});

test('known failed verification with rollback offers rollback rather than retry', () => {
  const model = buildRecoveryCenterModel([{
    actionId: 'a4',
    capability: 'workspace.edit.transaction',
    retryable: true,
    sideEffectState: 'known',
    reconciliationStatus: 'completed',
    verificationStatus: 'failed',
    rollbackAvailable: true,
    updatedAt: NOW
  }]);
  assert.equal(model.items[0]?.disposition, 'REVERSIBLE');
  assert.equal(model.items[0]?.recommendedAction, 'ROLLBACK');
  assert.equal(model.items[0]?.requiresFreshApproval, true);
});

test('completed and independently verified recovery is terminal with no action', () => {
  const model = buildRecoveryCenterModel([{
    actionId: 'a5',
    capability: 'workspace.edit.transaction',
    retryable: false,
    sideEffectState: 'known',
    reconciliationStatus: 'completed',
    verificationStatus: 'passed',
    updatedAt: NOW
  }]);
  assert.equal(model.items[0]?.disposition, 'TERMINAL');
  assert.equal(model.items[0]?.recommendedAction, 'NONE');
});

test('retryable flag alone cannot authorize retry when an effect is known', () => {
  const model = buildRecoveryCenterModel([{
    actionId: 'a6',
    capability: 'docker.manage',
    retryable: true,
    sideEffectState: 'known',
    rollbackAvailable: false,
    updatedAt: NOW
  }]);
  assert.equal(model.items[0]?.disposition, 'BLOCKED');
  assert.equal(model.items[0]?.recommendedAction, 'ESCALATE');
});

test('guided onboarding exposes exactly the earliest incomplete step', () => {
  const model = buildGuidedOnboardingModel({
    runtimeInstalled: true,
    doctorHealthy: true,
    authenticated: false,
    devicePaired: true,
    rootsConfigured: true,
    readProbePassed: true,
    approvalProbePassed: true,
    guidedTaskVerified: true
  });
  assert.equal(model.completed, false);
  assert.equal(model.nextStep, 'AUTHENTICATE');
  assert.equal(model.steps.find((step) => step.id === 'AUTHENTICATE')?.status, 'READY');
  assert.equal(model.steps.find((step) => step.id === 'PAIR_DEVICE')?.status, 'BLOCKED');
  assert.equal(model.steps.find((step) => step.id === 'PAIR_DEVICE')?.blockingStep, 'AUTHENTICATE');
});

test('guided onboarding completes only after a verified task', () => {
  const incomplete = buildGuidedOnboardingModel({
    runtimeInstalled: true,
    doctorHealthy: true,
    authenticated: true,
    devicePaired: true,
    rootsConfigured: true,
    readProbePassed: true,
    approvalProbePassed: true,
    guidedTaskVerified: false
  });
  assert.equal(incomplete.nextStep, 'GUIDED_VERIFIED_TASK');
  assert.equal(incomplete.completed, false);

  const complete = buildGuidedOnboardingModel({
    runtimeInstalled: true,
    doctorHealthy: true,
    authenticated: true,
    devicePaired: true,
    rootsConfigured: true,
    readProbePassed: true,
    approvalProbePassed: true,
    guidedTaskVerified: true
  });
  assert.equal(complete.completed, true);
  assert.equal(complete.nextStep, undefined);
  assert.ok(complete.steps.every((step) => step.status === 'COMPLETE'));
});
