import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EvaluationStore } from '../src/core/evaluation.ts';

const contractDigest = crypto.createHash('sha256').update('immutable-contract').digest('hex');
const scenario = {
  id: 'browser.nonbenchmark-form',
  version: 1,
  category: 'browser' as const,
  title: 'Verify a generic form workflow',
  contractDigest,
  requiredCapabilities: ['browser.interact'],
  chaosTags: ['dynamic-ui']
};
async function fixture(t: test.TestContext): Promise<{ store: EvaluationStore; directory: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-scenario-idempotence-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { store: new EvaluationStore(directory), directory };
}

test('scenario re-registration is idempotent when caller did not supply createdAt', async t => {
  const { store } = await fixture(t);
  const first = await store.registerScenario(scenario);
  const again = await store.registerScenario(scenario);
  assert.deepEqual(again, first);
  assert.equal(again.createdAt, first.createdAt);
});

test('scenario re-registration remains idempotent across separate store instances', async t => {
  const { store, directory } = await fixture(t);
  const original = await store.registerScenario(scenario);
  const restarted = await new EvaluationStore(directory).registerScenario(scenario);
  assert.deepEqual(restarted, original);
});

test('scenario contract mismatch keeps conflict fence instead of replacing existing evidence', async t => {
  const { store } = await fixture(t);
  await store.registerScenario(scenario);
  await assert.rejects(
    () => store.registerScenario({ ...scenario, title: 'Unauthorized replacement scenario' }),
    (error: any) => error?.code === 'EVALUATION_SCENARIO_CONFLICT'
  );
  await assert.rejects(
    () => store.registerScenario({ ...scenario, contractDigest: 'f'.repeat(64) }),
    (error: any) => error?.code === 'EVALUATION_SCENARIO_CONFLICT'
  );
});

test('explicit differing timestamp remains a conflicting immutable registration', async t => {
  const { store } = await fixture(t);
  await store.registerScenario({ ...scenario, createdAt: '2026-10-24T00:00:00.000Z' });
  await assert.rejects(
    () => store.registerScenario({ ...scenario, createdAt: '2026-10-24T00:00:01.000Z' }),
    (error: any) => error?.code === 'EVALUATION_SCENARIO_CONFLICT'
  );
});
