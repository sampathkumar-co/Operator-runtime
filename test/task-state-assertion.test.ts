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


test('C07 non-JSON assertion numbers cannot impersonate observed null', () => {
  for (const value of [Number.NaN, Infinity, -Infinity]) {
    assert.throws(() => normalizeTaskStateAssertions([
      { path: 'count', operator: 'equals', value }
    ]), (error: any) => error?.code === 'TASK_GOAL_INVALID');
  }
  const genuineNull = normalizeTaskStateAssertions([
    { path: 'count', operator: 'equals', value: null }
  ]);
  assert.doesNotThrow(() => assertTaskMachineState({ count: null }, genuineNull));
  assert.throws(() => assertTaskMachineState({ count: 0 }, genuineNull),
    (error: any) => error?.code === 'TASK_AUTONOMOUS_VERIFICATION_FAILED');
});

test('C07 assertions refuse hidden, cyclic, executable and sparse JSON values', () => {
  const cyclic: any = { claim: true }; cyclic.loop = cyclic;
  const getter = Object.defineProperty({}, 'token', {
    enumerable: true, get() { throw Error('accessor must not execute'); }
  });
  const hidden = Object.defineProperty({}, 'secret', { value: 'must not be ignored' });
  const sparse = new Array(2); sparse[0] = 'first';
  const symbols = { [Symbol('hidden')]: true };
  for (const value of [
    cyclic, getter, hidden, sparse, symbols, { secret: undefined },
    { nested: { value: Infinity } }, { fn: () => true },
    new Date('2026-10-26T00:00:00.000Z'), 'a'.repeat(17 * 1024)
  ]) {
    assert.throws(
      () => normalizeTaskStateAssertions([{ path: 'state', operator: 'equals', value }]),
      (error: any) => error?.code === 'TASK_GOAL_INVALID'
    );
  }
  const dense = { ids: ['a', null, { selected: true }], count: 3 };
  const validated = normalizeTaskStateAssertions([
    { path: 'state', operator: 'equals', value: dense }
  ]);
  assert.deepEqual(validated[0]?.value, dense);
  assert.notEqual(validated[0]?.value, dense);
  assert.doesNotThrow(() => assertTaskMachineState({ state: dense }, validated));
});
