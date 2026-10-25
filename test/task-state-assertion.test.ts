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

test('C07 typed state assertions cannot coerce arrays or objects into trusted proof paths', () => {
  let calls=0;
  const hostile={toString(){calls++; throw new Error('untrusted coercion');}};
  for(const malformed of [
    {path:['browser.expanded'],operator:'equals',value:true},
    {path:hostile,operator:'exists'},
    {path:0,operator:'exists'},
    {path:'browser.expanded',operator:['equals'],value:true},
    {path:'browser.expanded',operator:hostile,value:true},
    {path:'browser.expanded',operator:0,value:true}
  ]) {
    assert.throws(()=>normalizeTaskStateAssertions([malformed]),
      (error:any)=>error?.code==='TASK_GOAL_INVALID');
  }
  assert.equal(calls,0,'untrusted object coercion must never run');
  const valid=normalizeTaskStateAssertions([{path:'browser.expanded',operator:'equals',value:true}]);
  assert.doesNotThrow(()=>assertTaskMachineState({browser:{expanded:true}},valid));
});
