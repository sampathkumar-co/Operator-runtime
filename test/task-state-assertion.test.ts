import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTaskMachineState, normalizeTaskStateAssertions } from '../src/core/task-state-assertion.ts';

test('strict not_equals requires the asserted field to exist', () => {
  const assertions = normalizeTaskStateAssertions([
    { path: 'browser.expanded', operator: 'not_equals', value: false }
  ]);

  assert.throws(
    () => assertTaskMachineState({ browser: {} }, assertions),
    (error: any) => error?.code === 'TASK_AUTONOMOUS_VERIFICATION_FAILED'
  );
});

test('strict not_equals succeeds only for an existing different value', () => {
  const assertions = normalizeTaskStateAssertions([
    { path: 'browser.expanded', operator: 'not_equals', value: false }
  ]);

  assert.doesNotThrow(() => assertTaskMachineState({ browser: { expanded: true } }, assertions));
  assert.throws(
    () => assertTaskMachineState({ browser: { expanded: false } }, assertions),
    (error: any) => error?.code === 'TASK_AUTONOMOUS_VERIFICATION_FAILED'
  );
});
