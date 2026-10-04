import assert from 'node:assert/strict';
import test from 'node:test';
import { decisionBudgetExhaustion, taskDecisionBudget } from '../src/core/task-decision-budget.ts';
import type { TaskExecution } from '../src/core/task.ts';

test('decision budget separately accounts durable observations, retries, reconciliation and elapsed time', () => {
  const execution: TaskExecution = {
    schemaVersion: 1, plannerId: 'test', goalKind: 'test', plannerState: {}, maxSteps: 10,
    maxAttemptsPerStep: 2, timeoutMs: 1000, stepCount: 2, dispatchedActions: 2,
    plannerIterations: 3, preDispatchReobserves: 1, startedAt: '2026-10-04T00:00:00.000Z',
    deadlineAt: '2026-10-04T00:00:01.000Z',
    records: [{
      stepKey: 'read', actionId: 'a', capability: 'file.info', risk: 'read', inputHash: 'a'.repeat(64),
      attempt: 2, state: 'SUCCEEDED', startedAt: '2026-10-04T00:00:00.000Z',
      observation: { schemaVersion: 1, channel: 'visual', domain: 'visual', provider: 'visual', observedAt: '2026-10-04T00:00:00.100Z' }, evidence: []
    }],
    plannerEvents: [{ kind: 'RECONCILIATION_REQUIRED', decision: 'RECONCILE', code: 'UNCERTAIN', at: '2026-10-04T00:00:00.200Z', provider: 'test', capability: 'file.info' }]
  };
  const budget = taskDecisionBudget(execution, Date.parse('2026-10-04T00:00:00.500Z'));
  assert.deepEqual(budget.modelCalls, { used: 0, limit: 20, remaining: 20 });
  assert.deepEqual(budget.tokens, { used: 0, limit: 1_000_000, remaining: 1_000_000 });
  assert.deepEqual(budget.estimatedCostMicros, { used: 0, limit: 10_000_000, remaining: 10_000_000 });
  assert.equal(budget.readObservations.used, 1);
  assert.equal(budget.visualCaptures.used, 1);
  assert.equal(budget.retries.used, 1);
  assert.equal(budget.reconciliations.used, 1);
  assert.equal(budget.elapsedMs.used, 500);
  assert.equal(decisionBudgetExhaustion(budget), undefined);
});

test('verified progress extends only planner iterations under a hard maxSteps ceiling', () => {
  const execution: TaskExecution = {
    schemaVersion: 1, plannerId: 'test', goalKind: 'test', plannerState: {}, maxSteps: 3,
    maxAttemptsPerStep: 1, timeoutMs: 1000, stepCount: 1, dispatchedActions: 1,
    plannerIterations: 11, progressExtensions: 2, progressProofDigests: ['a'.repeat(64), 'b'.repeat(64)],
    records: []
  };
  const budget = taskDecisionBudget(execution, 0);
  assert.deepEqual(budget.plannerIterations, { used: 11, limit: 14, remaining: 3 });
  assert.deepEqual(budget.environmentActions, { used: 1, limit: 3, remaining: 2 });

  execution.progressExtensions = 99;
  assert.equal(taskDecisionBudget(execution, 0).plannerIterations.limit, 15);
});
