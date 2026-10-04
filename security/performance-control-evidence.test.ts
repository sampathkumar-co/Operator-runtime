import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PERFORMANCE_CONTROL_EVIDENCE } from '../src/core/performance-evidence.ts';

test('every performance-program phase is bound to an implementation and executable regression', async () => {
  assert.deepEqual(PERFORMANCE_CONTROL_EVIDENCE.map((item) => item.phase), Array.from({ length: 15 }, (_, index) => index + 1));
  for (const item of PERFORMANCE_CONTROL_EVIDENCE) {
    const implementation = await fs.readFile(path.resolve(item.implementationFile), 'utf8');
    const regression = item.executableTestFile === item.implementationFile ? implementation : await fs.readFile(path.resolve(item.executableTestFile), 'utf8');
    assert.ok(implementation.includes(item.implementationSymbol), `${item.control} implementation symbol is missing`);
    assert.ok(regression.includes(item.executableTestName), `${item.control} executable regression is missing`);
    assert.equal(item.status, 'EXECUTABLE');
  }
});
