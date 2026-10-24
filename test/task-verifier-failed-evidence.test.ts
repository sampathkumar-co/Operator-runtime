import assert from 'node:assert/strict';
import test from 'node:test';
import { createTask } from '../src/core/task.ts';
import { verifyTaskCompletion } from '../src/core/task-verifier.ts';
import type { Evidence } from '../src/core/types.ts';
import type { TaskCapsule } from '../src/core/task.ts';

function evidence(status: Evidence['status']): Evidence {
  return {
    kind: 'provider_execution', status,
    message: `synthetic ${status} evidence`,
    timestamp: '2026-10-24T00:00:01.000Z'
  };
}
function fixture(status?: Evidence['status'], state: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED'): TaskCapsule {
  const task = createTask({
    userObjective: 'Verify a synthetic custom workflow',
    interpretedObjective: 'Verify a synthetic custom workflow',
    authorizedScope: [], prohibitedScope: [],
    successConditions: ['A trusted external outcome was observed']
  });
  task.execution = {
    schemaVersion: 1, plannerId: 'custom.synthetic.v1', goalKind: 'custom',
    plannerState: {}, maxSteps: 1, maxAttemptsPerStep: 1,
    timeoutMs: 10_000, stepCount: 1,
    records: [{
      stepKey: 'step', actionId: 'action', capability: 'file.read', risk: 'read',
      inputHash: 'a'.repeat(64), attempt: 1, state,
      startedAt: '2026-10-24T00:00:00.000Z',
      ...(state === 'FAILED' ? { errorCode: 'READ_FAILED' } : {}),
      evidence: status ? [evidence(status)] : []
    }]
  };
  return task;
}

test('custom planner cannot complete when its sole durable evidence reports failure', () => {
  const result = verifyTaskCompletion(fixture('fail'));
  assert.equal(result.ok, false);
  assert.equal(result.bundle.checks.find(check => check.name === 'evidence-present')?.ok, false);
});

test('custom planner cannot treat INFO-only event as proof of outcome', () => {
  const result = verifyTaskCompletion(fixture('info'));
  assert.equal(result.ok, false);
  assert.equal(result.bundle.checks.find(check => check.name === 'evidence-present')?.ok, false);
});

test('a failed action with positive diagnostic evidence is still not a completed task', () => {
  const result = verifyTaskCompletion(fixture('pass', 'FAILED'));
  assert.equal(result.ok, false);
  assert.equal(result.bundle.checks.find(check => check.name === 'evidence-present')?.ok, false);
});

test('legacy custom planner still recognizes a succeeded action with positive provider evidence', () => {
  const result = verifyTaskCompletion(fixture('pass'));
  assert.equal(result.ok, true);
  assert.equal(result.bundle.checks.find(check => check.name === 'evidence-present')?.ok, true);
});

test('an observation attached only to a failed action cannot satisfy evidence presence', () => {
  const task = fixture(undefined, 'FAILED');
  task.execution!.records[0]!.observation = {
    schemaVersion: 1, channel: 'semantic', domain: 'filesystem',
    provider: 'synthetic', observedAt: '2026-10-24T00:00:01.000Z'
  };
  const result = verifyTaskCompletion(task);
  assert.equal(result.ok, false);
  assert.equal(result.bundle.checks.find(check => check.name === 'evidence-present')?.ok, false);
});
