import assert from 'node:assert/strict';
import test from 'node:test';
import { validProcessInstance } from '../src/core/process-instance.ts';

test('OS process identities require a native integer PID, never coerced external metadata', () => {
  const started = 'windows-filetime:134355626404730000';
  const pid = 4142;
  assert.deepEqual(validProcessInstance({ pid, started }), { pid, started });
  // A numeric string or array is not the OS PID, even if Number(value) matches.
  for (const malformed of ['4142', [4142], ' 4142 ', { valueOf: () => pid }]) {
    assert.equal(validProcessInstance({ pid: malformed, started }), null);
  }
  for (const malformed of [true, '1', [1], null, false, 0, -1, 1.5, Number.NaN, 2147483648]) {
    assert.equal(validProcessInstance({ pid: malformed, started }), null);
  }
  assert.equal(validProcessInstance({ pid, started: '' }), null);
  assert.equal(validProcessInstance({ pid, started: 134355626404730000 }), null);
});
