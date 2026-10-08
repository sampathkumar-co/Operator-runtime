import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedTestConcurrency } from '../scripts/test-concurrency.ts';

test('Windows integration files run serially while other platforms retain bounded parallelism', () => {
  for (const count of [1, 2, 4, 16]) {
    assert.equal(boundedTestConcurrency(count, 'win32'), 1);
  }
  assert.equal(boundedTestConcurrency(1, 'linux'), 1);
  assert.equal(boundedTestConcurrency(2, 'linux'), 2);
  assert.equal(boundedTestConcurrency(16, 'linux'), 2);
  assert.equal(boundedTestConcurrency(16, 'darwin'), 2);
  for (const invalid of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => boundedTestConcurrency(invalid, 'win32'), /positive safe integer/);
    assert.throws(() => boundedTestConcurrency(invalid, 'linux'), /positive safe integer/);
  }
});
