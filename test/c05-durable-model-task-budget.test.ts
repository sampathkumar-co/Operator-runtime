import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTask } from '../src/core/task.ts';
import { TaskStore } from '../src/core/task-store.ts';
import { decisionBudgetExhaustion, taskDecisionBudget } from '../src/core/task-decision-budget.ts';

function makeTask() {
  const task = createTask({
    userObjective: 'Verified model budget',
    interpretedObjective: 'Bound model requests to durable authorization',
    authorizedScope: ['test-root'], prohibitedScope: [],
    successConditions: ['No uncharged model calls']
  });
  task.execution = {
    schemaVersion: 1, plannerId: 'test-model-planner', goalKind: 'test',
    plannerState: {}, maxSteps: 3, maxAttemptsPerStep: 1,
    timeoutMs: 60_000, stepCount: 0, records: []
  };
  return task;
}

test('C05 model-call, token and spend reservations survive task restart without refunds', async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'model-charge-ledger-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const store = new TaskStore(state);
  const task = makeTask();
  task.execution!.modelCallCount = 2;
  task.execution!.modelReservedTokens = 600;
  task.execution!.modelReservedCostMicros = 40;
  await store.put(task);
  const restored = await new TaskStore(state).get(task.id);
  const budget = taskDecisionBudget(restored.execution!, Date.now());
  assert.deepEqual(budget.modelCalls, { used: 2, limit: 6, remaining: 4 });
  assert.deepEqual(budget.tokens, { used: 600, limit: 300_000, remaining: 299_400 });
  assert.deepEqual(budget.estimatedCostMicros, { used: 40, limit: 3_000_000, remaining: 2_999_960 });
});

test('C05 existing no-model tasks remain backward compatible without inventing charges', async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'model-charge-legacy-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const task = makeTask();
  await new TaskStore(state).put(task);
  const original = await new TaskStore(state).get(task.id);
  assert.equal(original.execution?.modelCallCount, undefined);
  assert.equal(taskDecisionBudget(original.execution!, Date.now()).modelCalls.used, 0);
});

test('C05 malformed or uncharged persisted model reservations are rejected on restart', async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'model-charge-corrupt-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const task = makeTask();
  await new TaskStore(state).put(task);
  const location = path.join(state, 'tasks', task.id + '.json');
  const originals = [
    { modelCallCount: 1.5, modelReservedTokens: 300 },
    { modelCallCount: -1, modelReservedTokens: 300 },
    { modelCallCount: 1, modelReservedTokens: -4 },
    { modelCallCount: 1, modelReservedTokens: Infinity },
    { modelCallCount: 1, modelReservedTokens: '300' },
    { modelCallCount: 1, modelReservedTokens: null },
    { modelCallCount: true, modelReservedTokens: 300 },
    { modelCallCount: 1, modelReservedTokens: 300, modelReservedCostMicros: '0' },
    { modelCallCount: 0, modelReservedTokens: 300 },
    { modelCallCount: 1, modelReservedTokens: 0 },
    { modelCallCount: 1, modelReservedTokens: 300, modelReservedCostMicros: -1 },
    { modelCallCount: 8, modelReservedTokens: 300 },
    { modelCallCount: 1, modelReservedTokens: 400_000 },
    { modelCallCount: 1, modelReservedTokens: 300, modelReservedCostMicros: 4_000_000 }
  ];
  for (const data of originals) {
    const bad = { ...task, execution: { ...task.execution, ...data } };
    await fs.writeFile(location, JSON.stringify(bad), { mode: 0o600 });
    await assert.rejects(() => new TaskStore(state).get(task.id),
      (error: any) => error?.code === 'TASK_STATE_CORRUPT');
  }
});

test('C05 corrupt in-memory model usage always exhausts the corresponding budget', () => {
  const task = makeTask();
  const execution = task.execution!;
  execution.modelCallCount = Number.NaN;
  assert.equal(decisionBudgetExhaustion(taskDecisionBudget(execution, Date.now())), 'modelCalls');
  execution.modelCallCount = 1;
  execution.modelReservedTokens = Number.POSITIVE_INFINITY;
  assert.equal(decisionBudgetExhaustion(taskDecisionBudget(execution, Date.now())), 'tokens');
  execution.modelReservedTokens = 100;
  execution.modelReservedCostMicros = -1;
  assert.equal(decisionBudgetExhaustion(taskDecisionBudget(execution, Date.now())), 'estimatedCostMicros');
});
