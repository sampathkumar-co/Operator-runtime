import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EvaluationStore } from '../src/core/evaluation.ts';

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-eval-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

test('stage18 distinguishes claimed success from independently verified success', async (t) => {
  const store = new EvaluationStore(await temp(t));
  await store.registerScenario({
    id: 'desktop.export',
    version: 1,
    category: 'desktop',
    title: 'Export a project',
    contractDigest: digest('contract'),
    requiredCapabilities: ['app.operate'],
    chaosTags: ['ui-shift']
  });
  const now = new Date().toISOString();
  await store.recordRun({
    id: crypto.randomUUID(),
    scenarioId: 'desktop.export',
    scenarioVersion: 1,
    runtimeVersion: '3.0.0',
    sourceCommit: 'a'.repeat(40),
    startedAt: now,
    finishedAt: now,
    claimedSuccess: true,
    verifiedSuccess: false,
    recoveredFailure: false,
    humanInterventions: 1,
    actionCount: 10,
    modelCalls: 3,
    tokenCount: 1000,
    latencyMs: 5000,
    costMicros: 20000,
    fallbackCount: 2,
    uncertainMutationCount: 1,
    evidenceDigest: digest('run')
  });
  const summary = await store.summary({ runtimeVersion: '3.0.0' });
  assert.equal(summary.claimedSuccesses, 1);
  assert.equal(summary.verifiedSuccesses, 0);
  assert.equal(summary.falseSuccesses, 1);
  assert.equal(summary.falseSuccessRate, 1);
});

test('stage18 regression comparison flags reliability improvements and regressions', async (t) => {
  const store = new EvaluationStore(await temp(t));
  await store.registerScenario({
    id: 'recovery.network',
    version: 1,
    category: 'recovery',
    title: 'Recover after network loss',
    contractDigest: digest('recovery'),
    requiredCapabilities: [],
    chaosTags: ['network-drop']
  });
  for (const [version, commit, verified, latency] of [
    ['1.0.0', 'a'.repeat(40), false, 6000],
    ['2.0.0', 'b'.repeat(40), true, 3000]
  ] as const) {
    const now = new Date().toISOString();
    await store.recordRun({
      id: crypto.randomUUID(), scenarioId: 'recovery.network', scenarioVersion: 1,
      runtimeVersion: version, sourceCommit: commit, startedAt: now, finishedAt: now,
      claimedSuccess: verified, verifiedSuccess: verified, recoveredFailure: verified,
      humanInterventions: 0, actionCount: 5, modelCalls: 1, tokenCount: 100,
      latencyMs: latency, costMicros: 1000, fallbackCount: 0, uncertainMutationCount: 0,
      evidenceDigest: digest(version)
    });
  }
  const comparison = await store.compare({
    baseline: { runtimeVersion: '1.0.0' },
    candidate: { runtimeVersion: '2.0.0' }
  });
  assert.ok(comparison.improved.includes('verifiedSuccessRate'));
  assert.ok(comparison.improved.includes('averageLatencyMs'));
  assert.equal(comparison.regressed.length, 0);
});

test('stage18 run IDs are retry-idempotent but conflict-safe', async (t) => {
  const store = new EvaluationStore(await temp(t));
  await store.registerScenario({
    id: 'security.prompt',
    version: 1,
    category: 'security',
    title: 'Ignore prompt injection',
    contractDigest: digest('security'),
    requiredCapabilities: [],
    chaosTags: ['prompt-injection']
  });
  const now = new Date().toISOString();
  const run = {
    id: crypto.randomUUID(), scenarioId: 'security.prompt', scenarioVersion: 1,
    runtimeVersion: '1.0.0', sourceCommit: 'c'.repeat(40), startedAt: now, finishedAt: now,
    claimedSuccess: true, verifiedSuccess: true, recoveredFailure: false,
    humanInterventions: 0, actionCount: 1, modelCalls: 1, tokenCount: 10,
    latencyMs: 10, costMicros: 10, fallbackCount: 0, uncertainMutationCount: 0,
    evidenceDigest: digest('security-run')
  };
  await store.recordRun(run);
  await store.recordRun(run);
  await assert.rejects(
    () => store.recordRun({ ...run, verifiedSuccess: false }),
    (error: any) => error?.code === 'EVALUATION_RUN_CONFLICT'
  );
});
