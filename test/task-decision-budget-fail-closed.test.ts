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

test('C05 fractional or unsafe persisted usage never rounds down into extra model or action budget', () => {
  for (const field of ['plannerIterations', 'dispatchedActions', 'preDispatchReobserves'] as const) {
    for (const value of [0.5, 1.75, Number.MAX_SAFE_INTEGER + 1]) {
      const task = execution();
      task[field] = value;
      const budget = taskDecisionBudget(task, 1000);
      const dimension = field === 'plannerIterations' ? budget.plannerIterations
        : field === 'dispatchedActions' ? budget.environmentActions : budget.reobserves;
      assert.equal(dimension.remaining, 0, `${field}=${value}`);
      assert.equal(dimension.used, dimension.limit);
      assert.ok(decisionBudgetExhaustion(budget), `${field}=${value}`);
    }
  }
});

test('C05 fractional and unsafe progress extensions cannot mint planner steps', () => {
  for (const extension of [0.5, 1.5, -0.25, -1, Number.POSITIVE_INFINITY,
    Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const task = execution();
    task.progressExtensions = extension;
    task.plannerIterations = 12;
    const budget = taskDecisionBudget(task, 1000);
    assert.equal(budget.plannerIterations.limit, 12);
    assert.equal(budget.plannerIterations.remaining, 0, String(extension));
    assert.equal(decisionBudgetExhaustion(budget), 'plannerIterations');
  }
  const valid = execution();
  valid.progressExtensions = 2;
  valid.plannerIterations = 12;
  assert.equal(taskDecisionBudget(valid, 1000).plannerIterations.remaining, 2);
});

test('C05 clock rollback and corrupted or exceeded durable deadline exhaust task time', () => {
  const task = execution();
  task.startedAt = '2026-10-25T12:00:00.000Z';
  task.deadlineAt = '2026-10-25T12:00:05.000Z';
  for (const now of [
    Date.parse('2026-10-25T11:59:59.999Z'),
    Date.parse('2026-10-25T12:00:05.000Z'),
    Date.parse('2026-10-25T12:00:08.000Z')
  ]) {
    const budget = taskDecisionBudget(task, now);
    assert.equal(budget.elapsedMs.remaining, 0);
    assert.equal(decisionBudgetExhaustion(budget), 'elapsedMs');
  }
  for (const deadlineAt of ['invalid-date', '2026-10-25T11:59:59.000Z']) {
    task.deadlineAt = deadlineAt;
    const budget = taskDecisionBudget(task, Date.parse('2026-10-25T12:00:01.000Z'));
    assert.equal(budget.elapsedMs.remaining, 0);
  }
  task.deadlineAt = '2026-10-25T12:00:05.000Z';
  const healthy = taskDecisionBudget(task, Date.parse('2026-10-25T12:00:01.000Z'));
  assert.equal(healthy.elapsedMs.used, 1000);
  assert.equal(healthy.elapsedMs.remaining, 4000);
});
