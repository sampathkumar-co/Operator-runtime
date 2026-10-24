import assert from 'node:assert/strict';
import test from 'node:test';
import { decisionBudgetExhaustion, taskDecisionBudget } from '../src/core/task-decision-budget.ts';
import type { TaskExecution } from '../src/core/task.ts';

function execution(): TaskExecution {
  return {
    schemaVersion: 1, plannerId: 'synthetic', goalKind: 'generic',
    plannerState: {}, maxSteps: 3, maxAttemptsPerStep: 2, timeoutMs: 5000,
    stepCount: 1, dispatchedActions: 1, plannerIterations: 1,
    records: []
  };
}
test('invalid durable action count exhausts instead of permitting unbounded dispatch', () => {
  for (const value of [Number.NaN, Infinity, -Infinity, -1]) {
    const task = execution();
    task.dispatchedActions = value;
    const budget = taskDecisionBudget(task, 1000);
    assert.equal(budget.environmentActions.remaining, 0);
    assert.equal(decisionBudgetExhaustion(budget), 'environmentActions');
  }
});
test('invalid planner iteration or progress extension cannot bypass its budget', () => {
  let task = execution();
  task.plannerIterations = Number.NaN;
  let budget = taskDecisionBudget(task, 1000);
  assert.equal(budget.plannerIterations.remaining, 0);
  assert.equal(decisionBudgetExhaustion(budget), 'plannerIterations');

  task = execution();
  task.progressExtensions = Number.NaN;
  budget = taskDecisionBudget(task, 1000);
  assert.equal(budget.plannerIterations.remaining, 0);
  assert.equal(decisionBudgetExhaustion(budget), 'plannerIterations');
});
test('invalid persisted hard limits fail closed before generating any budget', () => {
  for (const field of ['maxSteps', 'maxAttemptsPerStep', 'timeoutMs'] as const) {
    for (const value of [0, Number.NaN, Infinity, -1, 1.5]) {
      const task = execution();
      task[field] = value;
      assert.throws(
        () => taskDecisionBudget(task, 1000),
        (error: any) => error?.code === 'TASK_DECISION_BUDGET_INVALID'
      );
    }
  }
});
test('valid no-retry tasks are not blocked by their zero retry allowance', () => {
  const task = execution();
  task.maxAttemptsPerStep = 1;
  task.dispatchedActions = 0;
  task.stepCount = 0;
  task.plannerIterations = 0;
  const budget = taskDecisionBudget(task, 1000);
  assert.deepEqual(budget.retries, { used: 0, limit: 0, remaining: 0 });
  assert.equal(decisionBudgetExhaustion(budget), undefined);
});
test('normal finite task budgets retain their prior accounting', () => {
  const budget = taskDecisionBudget(execution(), 1000);
  assert.deepEqual(budget.environmentActions, { used: 1, limit: 3, remaining: 2 });
  assert.deepEqual(budget.plannerIterations, { used: 1, limit: 12, remaining: 11 });
});
