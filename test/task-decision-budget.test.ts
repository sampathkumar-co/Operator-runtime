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
  assert.equal(budget.readObservations.used, 1);
  assert.equal(budget.visualCaptures.used, 1);
  assert.equal(budget.retries.used, 1);
  assert.equal(budget.reconciliations.used, 1);
  assert.equal(budget.elapsedMs.used, 500);
  assert.equal(decisionBudgetExhaustion(budget), undefined);
});
