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

test('C10 recovery never recommends retry from a missing execution phase after possible dispatch', () => {
  for (const executionPhase of [undefined, 'dispatched', 'effect_observed', 'reconciled'] as const) {
    const model = buildRecoveryCenterModel([{
      actionId: 'unknown-phase' + (executionPhase ?? '-missing'),
      capability: 'browser.interact',
      retryable: true,
      sideEffectState: 'none',
      executionPhase,
      updatedAt: NOW
    }]);
    assert.equal(model.items[0]?.recommendedAction, 'ESCALATE', String(executionPhase));
    assert.equal(model.items[0]?.requiresFreshApproval, false);
  }
});

test('C10 confirmed pre-dispatch failure and proven not-applied effects can request separately approved retry', () => {
  const model = buildRecoveryCenterModel([
    {
      actionId: 'pre-dispatch', capability: 'browser.interact',
      retryable: true, sideEffectState: 'none',
      executionPhase: 'pre_dispatch', updatedAt: NOW
    },
    {
      actionId: 'reconciled-not-applied', capability: 'browser.interact',
      retryable: true, sideEffectState: 'none',
      executionPhase: 'dispatched', reconciliationStatus: 'not_applied', updatedAt: NOW
    },
    {
      actionId: 'inconsistent-completed', capability: 'browser.interact',
      retryable: true, sideEffectState: 'none',
      executionPhase: 'pre_dispatch', reconciliationStatus: 'completed', updatedAt: NOW
    }
  ]);
  assert.equal(model.items.find(x => x.actionId === 'pre-dispatch')?.recommendedAction, 'RETRY');
  assert.equal(model.items.find(x => x.actionId === 'reconciled-not-applied')?.recommendedAction, 'RETRY');
  assert.equal(model.items.find(x => x.actionId === 'inconsistent-completed')?.recommendedAction, 'ESCALATE');
  assert.equal(model.items.find(x => x.actionId === 'pre-dispatch')?.requiresFreshApproval, true);
});

test('C10 contradictory proof cannot silently close or authorize an uncertain recovery', () => {
  const cases = [
    { actionId:'no-effect-but-complete', capability:'file.replace', retryable:false,
      sideEffectState:'none' as const, reconciliationStatus:'completed' as const,
      verificationStatus:'passed' as const, updatedAt:NOW },
    { actionId:'not-applied-but-known', capability:'file.replace', retryable:true,
      sideEffectState:'known' as const, reconciliationStatus:'not_applied' as const,
      verificationStatus:'failed' as const, rollbackAvailable:true, updatedAt:NOW },
    { actionId:'no-effect-failed-verify', capability:'file.replace', retryable:false,
      sideEffectState:'none' as const, verificationStatus:'failed' as const,
      rollbackAvailable:true, updatedAt:NOW }
  ];
  const model = buildRecoveryCenterModel(cases);
  for (const candidate of cases) {
    const item = model.items.find(entry => entry.actionId === candidate.actionId)!;
    assert.notEqual(item.recommendedAction, 'NONE', candidate.actionId);
    assert.notEqual(item.recommendedAction, 'ROLLBACK', candidate.actionId);
    assert.notEqual(item.recommendedAction, 'RETRY', candidate.actionId);
    assert.equal(item.requiresFreshApproval, false, candidate.actionId);
  }
  assert.equal(model.items.find(x => x.actionId === 'not-applied-but-known')?.disposition, 'BLOCKED');
});

test('C10 known applied effect with failed independent proof still offers fresh-authority rollback', () => {
  const model = buildRecoveryCenterModel([{
    actionId:'known-failure',
    capability:'workspace.edit',
    retryable:false,
    sideEffectState:'known',
    reconciliationStatus:'completed',
    verificationStatus:'failed',
    rollbackAvailable:true,
    updatedAt:NOW
  }]);
  assert.equal(model.items[0]?.recommendedAction, 'ROLLBACK');
  assert.equal(model.items[0]?.requiresFreshApproval, true);
});

test('C10 forged object identifiers cannot acquire an approval or recovery display identity', () => {
  const fake = { toString: () => 'legitimate-action' };
  const approval = {
    actionId:'legitimate-action', approvalRequestId:'request-1',
    capability:'file.replace', risk:'write', status:'pending',
    createdAt:'2026-10-06T11:59:00.000Z', pendingExpiresAt:'2026-10-06T12:05:00.000Z'
  };
  for (const key of ['actionId','approvalRequestId','capability','createdAt','pendingExpiresAt'] as const) {
    assert.throws(
      () => buildApprovalCenterModel([{...approval,[key]:fake} as any],NOW),
      (e:any)=>e?.code==='CONTROL_CENTER_UX_INVALID',
      key
    );
  }
  const recovery = {
    actionId:'legitimate-action', capability:'file.replace',
    retryable:true, sideEffectState:'none', executionPhase:'pre_dispatch', updatedAt:NOW
  };
  for (const key of ['actionId','capability','updatedAt'] as const) {
    assert.throws(
      () => buildRecoveryCenterModel([{...recovery,[key]:fake} as any]),
      (e:any)=>e?.code==='CONTROL_CENTER_UX_INVALID',
      key
    );
  }
});


test('C10 independently passed verification must never be offered for a retry under no-effect claims', () => {
  const cases = [
    { actionId: 'contradicted-pre-dispatch', capability: 'file.replace',
      retryable: true, sideEffectState: 'none' as const,
      executionPhase: 'pre_dispatch' as const, verificationStatus: 'passed' as const,
      updatedAt: NOW },
    { actionId: 'contradicted-not-applied', capability: 'browser.interact',
      retryable: true, sideEffectState: 'none' as const,
      executionPhase: 'dispatched' as const, reconciliationStatus: 'not_applied' as const,
      verificationStatus: 'passed' as const, updatedAt: NOW },
    { actionId: 'contradicted-verified-result', capability: 'terminal.execute',
      retryable: true, sideEffectState: 'known' as const,
      reconciliationStatus: 'not_applied' as const,
      verificationStatus: 'passed' as const, updatedAt: NOW }
  ];
  const model = buildRecoveryCenterModel(cases);
  for (const candidate of cases) {
    const item = model.items.find(value => value.actionId === candidate.actionId)!;
    assert.equal(item.disposition, 'BLOCKED', candidate.actionId);
    assert.equal(item.recommendedAction, 'ESCALATE', candidate.actionId);
    assert.equal(item.requiresFreshApproval, false);
  }
  const ordinary = buildRecoveryCenterModel([{
    actionId: 'verified-failed-before-dispatch', capability: 'file.replace',
    retryable: true, sideEffectState: 'none' as const, executionPhase: 'pre_dispatch' as const,
    verificationStatus: 'failed' as const, updatedAt: NOW
  }]);
  assert.equal(ordinary.items[0]!.recommendedAction, 'RETRY',
    'a proven no-effect failed verification may still request fresh-authority retry');
});
