import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activateSubgoal, createDurableTaskPlan, nextReadySubgoal, normalizeDurableTaskPlan,
  reviseDurableTaskPlan, taskPlanComplete, verifySubgoal, type TaskPlanStepDefinition
} from '../src/core/task-plan.ts';

const at = '2026-10-04T00:00:00.000Z';
const later = '2026-10-04T00:00:01.000Z';

function step(key: string, dependsOn?: string[]): TaskPlanStepDefinition {
  return {
    key, title: key, ...(dependsOn ? { dependsOn } : {}), resourceScope: [`resource:${key}`],
    observe: { capability: 'file.info', input: { path: `C:/${key}` } },
    action: { capability: 'file.create', input: { path: `C:/${key}`, content: key } },
    verify: { capability: 'file.info', input: { path: `C:/${key}` }, assertions: [{ path: 'exists', operator: 'equals', value: true }] }
  };
}

test('durable task plan advances only dependency-ready subgoals and survives normalization', () => {
  const plan = createDurableTaskPlan({
    taskId: 'task-1', objective: 'finish two dependent outcomes', constraints: ['authorized:C:/'],
    finalSuccessConditions: ['both machine contracts pass'], steps: [step('first'), step('second')], now: at
  });
  assert.equal(nextReadySubgoal(plan)?.key, 'first');
  activateSubgoal(plan, plan.subgoals[0]!.id, at);
  verifySubgoal(plan, plan.subgoals[0]!.id, later);
  const restored = normalizeDurableTaskPlan(JSON.parse(JSON.stringify(plan)));
  assert.equal(restored.subgoals[0]!.status, 'VERIFIED');
  assert.equal(nextReadySubgoal(restored)?.key, 'second');
  assert.equal(taskPlanComplete(restored), false);
});

test('local plan revision inserts a prerequisite without invalidating verified unaffected work', () => {
  const plan = createDurableTaskPlan({
    taskId: 'task-2', objective: 'revise locally', constraints: ['bounded'], finalSuccessConditions: ['verified'],
    steps: [step('done', []), step('target', ['done'])], now: at
  });
  activateSubgoal(plan, plan.subgoals[0]!.id, at);
  verifySubgoal(plan, plan.subgoals[0]!.id, later);
  const revised = reviseDurableTaskPlan(plan, [{ kind: 'insert_prerequisite', beforeKey: 'target', step: step('repair') }], 'target needs one repair', '2026-10-04T00:00:02.000Z');
  assert.equal(revised.revision, 2);
  assert.equal(revised.subgoals.find((item) => item.key === 'done')?.status, 'VERIFIED');
  assert.equal(nextReadySubgoal(revised)?.key, 'repair');
  assert.deepEqual(revised.subgoals.find((item) => item.key === 'target')?.dependsOn, [revised.subgoals.find((item) => item.key === 'repair')?.id]);
});

test('durable task plan rejects dependency cycles', () => {
  assert.throws(() => createDurableTaskPlan({
    taskId: 'task-3', objective: 'cycle', constraints: ['bounded'], finalSuccessConditions: ['never'],
    steps: [step('a', ['b']), step('b', ['a'])], now: at
  }), (error: any) => error?.code === 'TASK_PLAN_INVALID');
});
