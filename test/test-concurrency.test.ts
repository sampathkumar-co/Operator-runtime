import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedTestConcurrency } from '../scripts/test-concurrency.ts';

test('test runner bounds file-level workers independently of task and benchmark content', () => {
  assert.equal(boundedTestConcurrency(1), 1);
  assert.equal(boundedTestConcurrency(2), 2);
  assert.equal(boundedTestConcurrency(4), 4);
  assert.equal(boundedTestConcurrency(16), 4);
  for (const invalid of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => boundedTestConcurrency(invalid), /positive safe integer/);
  }
});
