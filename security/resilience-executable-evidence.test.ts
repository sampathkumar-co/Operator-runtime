import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { CRITICAL_RESILIENCE_EVIDENCE } from '../src/core/resilience-evidence.ts';

test('critical resilience claims are bound to implementation symbols and executable fault tests', async () => {
  const expected = new Set([
    'uncertain-effect-crash', 'stale-intent-predispatch', 'approval-replay', 'duplicate-delivery',
    'process-restart', 'stale-resource-identity', 'verification-false-positive', 'compensation-crash', 'relay-partition'
  ]);
  assert.deepEqual(new Set(CRITICAL_RESILIENCE_EVIDENCE.map((entry) => entry.id)), expected);

  for (const entry of CRITICAL_RESILIENCE_EVIDENCE) {
    assert.equal(entry.status, 'EXECUTABLE');
    assert.ok(entry.injectedFault.length >= 20);
    assert.ok(entry.expectedEvidence.length >= 20);
    const implementation = await fs.readFile(path.resolve(entry.implementationFile), 'utf8');
    const executableTest = await fs.readFile(path.resolve(entry.executableTestFile), 'utf8');
    assert.ok(implementation.includes(entry.implementationSymbol), `${entry.id} implementation symbol is missing`);
    assert.ok(executableTest.includes(entry.executableTestName), `${entry.id} executable test is missing`);
  }
});
