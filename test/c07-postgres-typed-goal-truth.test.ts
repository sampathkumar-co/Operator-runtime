import assert from 'node:assert/strict';
import test from 'node:test';
import { createTask } from '../src/core/task.ts';
import { verifyGoalOutcomeTruth } from '../src/core/task-verifier.ts';

function makeGoal(goal: Record<string, unknown>) {
  return createTask({
    userObjective: 'Read registered database rows',
    interpretedObjective: 'Read bounded rows from the authorized table',
    authorizedScope: ['test-root'], prohibitedScope: [],
    successConditions: ['Matching bounded rows were inspected'],
    execution: {
      schemaVersion: 1, plannerId: 'operator.semantic.v1',
      goalKind: 'postgres-select', plannerState: { phase: 'complete', goal },
      maxSteps: 4, maxAttemptsPerStep: 1, timeoutMs: 30000,
      stepCount: 0, records: []
    }
  });
}

test('C07 PostgreSQL verifier rejects nonprimitive goal fields without coercion', () => {
  const base = {
    kind: 'postgres-select', root: '/registered', profileId: 'local',
    schema: 'public', table: 'items', columns: ['id'], limit: 25,
    offset: 0, timeoutMs: 5000
  };
  let coercions = 0;
  const malicious = { toString() { coercions++; return 'items'; }, valueOf() { coercions++; return 25; } };
  const mutations: Record<string, unknown>[] = [
    { table: ['items'] }, { table: malicious }, { profileId: malicious },
    { root: malicious }, { schema: malicious }, { columns: [['id']] },
    { columns: [malicious] }, { limit: '25' }, { limit: malicious },
    { offset: [0] }, { timeoutMs: '5000' }, { timeoutMs: Number.NaN },
    { limit: -1 }, { limit: Number.POSITIVE_INFINITY },
    { filters: malicious }, { orderBy: malicious }
  ];
  for (const changes of mutations) {
    const outcome = verifyGoalOutcomeTruth(makeGoal({ ...base, ...changes }));
    assert.equal(outcome.supported, true);
    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /malformed input types/);
  }
  assert.equal(coercions, 0, 'Verifier must not invoke untrusted conversion methods');
});

test('C07 PostgreSQL verifier preserves valid typed inputs for independent evidence evaluation', () => {
  const result = verifyGoalOutcomeTruth(makeGoal({
    kind: 'postgres-select', root: '/registered', profileId: 'local',
    table: 'items', columns: ['id'], limit: 25, offset: 0, timeoutMs: 5000
  }));
  assert.equal(result.supported, true);
  assert.equal(result.ok, false);
  assert.match(result.detail, /result evidence does not match/);
});
