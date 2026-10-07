import assert from 'node:assert/strict';
import test from 'node:test';
import { buildControlCenterProductSnapshot } from '../apps/local-agent/src/control-center-product.ts';

test('Control Center product snapshot exposes approval, recovery and onboarding truth', () => {
  const snapshot = buildControlCenterProductSnapshot({
    now: '2026-10-07T01:00:00.000Z',
    approvals: [{
      actionId: 'action:1',
      actionHash: 'a'.repeat(64),
      authorityHash: 'b'.repeat(64),
      approvalRequestId: 'approval:1',
      capability: 'git.commit',
      risk: 'write',
      status: 'pending',
      createdAt: '2026-10-07T00:59:00.000Z',
      pendingExpiresAt: '2026-10-07T01:09:00.000Z'
    }],
    tasks: [{
      id: 'task:1',
      userObjective: 'Change source',
      interpretedObjective: 'Change source',
      authorizedScope: [],
      prohibitedScope: [],
      successConditions: [],
      state: 'BLOCKED',
      nodes: [],
      evidence: [],
      failures: [],
      createdAt: '2026-10-07T00:00:00.000Z',
      updatedAt: '2026-10-07T00:59:30.000Z',
      execution: {
        schemaVersion: 1,
        plannerId: 'planner',
        goalKind: 'test',
        plannerState: {},
        maxSteps: 3,
        maxAttemptsPerStep: 2,
        timeoutMs: 1000,
        stepCount: 1,
        records: [{
          stepKey: 'step:1',
          actionId: 'action:1',
          capability: 'git.commit',
          risk: 'write',
          inputHash: 'c'.repeat(64),
          attempt: 1,
          state: 'BLOCKED',
          startedAt: '2026-10-07T00:59:00.000Z',
          errorCode: 'APPROVAL_REQUIRED',
          sideEffectState: 'none',
          executionPhase: 'pre_dispatch',
          evidence: []
        }],
        plannerEvents: [{
          schemaVersion: 1,
          taskId: 'task:1',
          plannerId: 'planner',
          iteration: 1,
          decisionType: 'step',
          code: 'APPROVAL_REQUIRED',
          reason: 'approval',
          authorityState: 'TASK_SCOPE_BOUND',
          resourceContext: { capability: 'git.commit' },
          observationDigest: 'd'.repeat(64),
          at: '2026-10-07T00:59:00.000Z',
          retryAllowed: true,
          reobserveAllowed: true,
          replanAllowed: true
        }]
      }
    } as any],
    onboarding: {
      runtimeInstalled: true,
      doctorHealthy: true,
      authenticated: true,
      devicePaired: true,
      rootsConfigured: true,
      readProbePassed: true,
      approvalProbePassed: false,
      guidedTaskVerified: false
    }
  });
  assert.equal(snapshot.approvals.counts.pending, 1);
  assert.equal(snapshot.recovery.items[0]?.recommendedAction, 'RETRY');
  assert.equal(snapshot.recovery.items[0]?.requiresFreshApproval, true);
  assert.equal(snapshot.onboarding.nextStep, 'APPROVAL_PROBE');
  assert.equal(snapshot.health.blockedTasks, 1);
});

test('post-dispatch missing effect truth is surfaced as uncertain, never retryable', () => {
  const snapshot = buildControlCenterProductSnapshot({
    now: '2026-10-07T01:00:00.000Z',
    approvals: [],
    tasks: [{
      id: 'task:2',
      userObjective: 'External change',
      interpretedObjective: 'External change',
      authorizedScope: [],
      prohibitedScope: [],
      successConditions: [],
      state: 'BLOCKED',
      nodes: [],
      evidence: [],
      failures: [],
      createdAt: '2026-10-07T00:00:00.000Z',
      updatedAt: '2026-10-07T00:59:30.000Z',
      execution: {
        schemaVersion: 1, plannerId: 'p', goalKind: 'x', plannerState: {}, maxSteps: 3,
        maxAttemptsPerStep: 2, timeoutMs: 1000, stepCount: 1,
        records: [{ stepKey:'s', actionId:'action:2', capability:'external.write', risk:'external', inputHash:'e'.repeat(64), attempt:1, state:'INTERRUPTED', startedAt:'2026-10-07T00:59:00.000Z', executionPhase:'dispatched', evidence:[] }]
      }
    } as any],
    onboarding: {
      runtimeInstalled:true, doctorHealthy:true, authenticated:true, devicePaired:true,
      rootsConfigured:true, readProbePassed:true, approvalProbePassed:true, guidedTaskVerified:false
    }
  });
  assert.equal(snapshot.recovery.items[0]?.disposition, 'UNCERTAIN');
  assert.equal(snapshot.recovery.items[0]?.recommendedAction, 'RECONCILE');
});
