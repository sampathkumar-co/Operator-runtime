import assert from 'node:assert/strict';
import test from 'node:test';
import { createTask, type TaskCapsule, type TaskActionRecord } from '../src/core/task.ts';
import { verifyGoalOutcomeTruth, verifyTaskCompletion } from '../src/core/task-verifier.ts';

function fixture(assertions: unknown): TaskCapsule {
  const record: TaskActionRecord = {
    stepKey: 'autonomous:0:verify', actionId: 'synthetic-verify-01',
    capability: 'browser.inspect', risk: 'read', inputHash: 'a'.repeat(64), attempt: 0,
    state: 'SUCCEEDED', startedAt: '2026-10-24T11:00:00.000Z',
    finishedAt: '2026-10-24T11:00:02.000Z', evidence: [],
    observation: {
      schemaVersion: 2, channel: 'semantic', domain: 'browser', provider: 'synthetic',
      capability: 'browser.inspect', entityId: 'browser:fixture',
      observedAt: '2026-10-24T11:00:01.000Z', stateVersion: 'b'.repeat(64),
      importantState: { verified: true }, epistemicStatus: 'KNOWN', epistemicReason: '',
      ambiguous: false, confidence: 1, evidenceRefs: ['c'.repeat(64)]
    }
  };
  return createTask({
    userObjective: 'Check a synthetic application state', interpretedObjective: 'Observe the expected postcondition',
    authorizedScope: ['fixture'], prohibitedScope: [], successConditions: ['verified must be true'],
    execution: {
      schemaVersion: 1, plannerId: 'operator.autonomous-workflow.v1',
      goalKind: 'autonomous-workflow',
      plannerState: {
        goal: { steps: [{ verify: { assertions } }] }, workflowIndex: 1, autonomousPhase: 'observe'
      },
      maxSteps: 10, maxAttemptsPerStep: 1, timeoutMs: 30_000, stepCount: 1,
      records: [record]
    }
  });
}
test('C07 a matching fresh known read-only machine assertion verifies a supported autonomous step', () => {
  const task = fixture([{ path: 'verified', operator: 'equals', value: true }]);
  assert.equal(verifyGoalOutcomeTruth(task).ok, true);
  assert.equal(verifyTaskCompletion(task).ok, true);
});
test('C07 empty or missing assertions cannot be treated as successful goal verification', () => {
  for (const assertions of [[], undefined, null, 'verified', {}]) {
    const task = fixture(assertions);
    assert.equal(verifyGoalOutcomeTruth(task).ok, false);
    assert.equal(verifyTaskCompletion(task).ok, false);
  }
});
test('C07 malformed or false state assertion rejects completed-looking planner output', () => {
  for (const assertions of [
    [{ path: 'verified', operator: 'equals', value: false }],
    [{ path: '__proto__.polluted', operator: 'exists' }],
    [{ path: 'verified', operator: 'unsupported', value: true }]
  ]) {
    const task = fixture(assertions);
    assert.equal(verifyGoalOutcomeTruth(task).ok, false);
    assert.equal(verifyTaskCompletion(task).ok, false);
  }
});
test('C07 stale, ambiguous, non-KNOWN and self-action verification results fail closed', () => {
  const mutations: Array<(record: TaskActionRecord) => void> = [
    r => { if (r.observation?.schemaVersion === 2) r.observation.observedAt = '2026-10-23T11:00:01.000Z'; },
    r => { if (r.observation?.schemaVersion === 2) r.observation.epistemicStatus = 'AMBIGUOUS'; },
    r => { if (r.observation?.schemaVersion === 2) r.observation.ambiguous = true; },
    r => { r.risk = 'external'; },
    r => { if (r.observation?.schemaVersion === 2) r.observation.capability = 'browser.interact'; },
    r => { r.startedAt = 'invalid-time'; }
  ];
  for (const change of mutations) {
    const task = fixture([{ path: 'verified', operator: 'equals', value: true }]);
    change(task.execution!.records[0]!);
    assert.equal(verifyGoalOutcomeTruth(task).ok, false);
    assert.equal(verifyTaskCompletion(task).ok, false);
  }
});
