import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EvaluationStore, type EvaluationRun } from '../src/core/evaluation.ts';

const BASE = 'a'.repeat(40);
const CANDIDATE = 'b'.repeat(40);
const digest = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

async function fixture(t: test.TestContext): Promise<EvaluationStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-matched-eval-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new EvaluationStore(directory);
  for (const id of ['browser.form', 'developer.edit']) {
    await store.registerScenario({
      id, version: 1, category: id.startsWith('browser') ? 'browser' : 'developer',
      title: id, contractDigest: digest(id), requiredCapabilities: [], chaosTags: [],
      createdAt: '2026-10-24T00:00:00.000Z'
    });
  }
  return store;
}

function run(commit: string, scenarioId: string, seed = 0, changes: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    id: crypto.randomUUID(), scenarioId, scenarioVersion: 1,
    runtimeVersion: commit === BASE ? '2.0.6' : '2.0.7',
    sourceCommit: commit, startedAt: '2026-10-24T00:00:00.000Z',
    finishedAt: '2026-10-24T00:00:01.000Z',
    claimedSuccess: false, verifiedSuccess: false, recoveredFailure: false,
    humanInterventions: 0, actionCount: 1, modelCalls: 0, tokenCount: 0,
    latencyMs: 1000, costMicros: 0, fallbackCount: 0, uncertainMutationCount: 0,
    evidenceDigest: digest('independent-fixture-evidence'),
    candidateDirty: false, runnerHash: digest('fixed-trace-runner'),
    seed, model: 'scripted', provider: 'none',
    modelConfigDigest: digest('model-neutral'),
    environmentDigest: digest('same-disposable-fixture'),
    ...changes
  };
}
const compare = (store: EvaluationStore) => store.compareMatched({
  baselineSourceCommit: BASE, candidateSourceCommit: CANDIDATE
});

test('strict comparator reports only paired, frozen scenario/seed workloads', async (t) => {
  const store = await fixture(t);
  for (const id of ['browser.form', 'developer.edit']) {
    await store.recordRun(run(BASE, id));
    await store.recordRun(run(CANDIDATE, id, 0, {
      claimedSuccess: true, verifiedSuccess: true, verificationState: 'verified', latencyMs: 600
    }));
  }
  const result = await compare(store);
  assert.equal(result.matchedPairs, 2);
  assert.equal(result.baseline.verifiedSuccessRate, 0);
  assert.equal(result.candidate.verifiedSuccessRate, 1);
  assert.ok(result.improved.includes('verifiedSuccessRate'));
  assert.ok(result.improved.includes('averageLatencyMs'));
});

test('strict comparator refuses empty candidate and missing scenario coverage', async (t) => {
  const store = await fixture(t);
  await store.recordRun(run(BASE, 'browser.form'));
  await assert.rejects(() => compare(store), (error: any) => error?.code === 'EVALUATION_NOT_COMPARABLE');
  await store.recordRun(run(CANDIDATE, 'developer.edit'));
  await assert.rejects(() => compare(store), (error: any) => error?.code === 'EVALUATION_NOT_COMPARABLE');
});

test('strict comparator rejects different seeds or test environment even when totals match', async (t) => {
  const store = await fixture(t);
  await store.recordRun(run(BASE, 'browser.form', 42));
  await store.recordRun(run(CANDIDATE, 'browser.form', 0));
  await assert.rejects(() => compare(store), (error: any) => error?.code === 'EVALUATION_NOT_COMPARABLE');
});

test('strict comparator rejects dirty source and missing experimental provenance', async (t) => {
  const store = await fixture(t);
  await store.recordRun(run(BASE, 'browser.form', 0, { candidateDirty: true }));
  await store.recordRun(run(CANDIDATE, 'browser.form'));
  await assert.rejects(() => compare(store), (error: any) => error?.code === 'EVALUATION_PROVENANCE_MISSING');
});

test('strict comparator refuses duplicate runs at one experiment identity', async (t) => {
  const store = await fixture(t);
  await store.recordRun(run(BASE, 'browser.form'));
  await store.recordRun(run(BASE, 'browser.form'));
  await store.recordRun(run(CANDIDATE, 'browser.form'));
  await assert.rejects(() => compare(store), (error: any) => error?.code === 'EVALUATION_DUPLICATE_COHORT_RUN');
});

test('strict comparator disallows comparing a source to itself', async (t) => {
  const store = await fixture(t);
  await assert.rejects(
    () => store.compareMatched({ baselineSourceCommit: BASE, candidateSourceCommit: BASE }),
    (error: any) => error?.code === 'EVALUATION_NOT_COMPARABLE'
  );
});

test('matched comparison detects p95 tail regression despite improved average and median latency', async t => {
  const store = await fixture(t);
  const baselineLatencies = [200, 200, 200, 1000];
  const candidateLatencies = [0, 0, 0, 1100];
  for (let seed = 0; seed < baselineLatencies.length; seed += 1) {
    await store.recordRun(run(BASE, 'browser.form', seed, { latencyMs: baselineLatencies[seed]! }));
    await store.recordRun(run(CANDIDATE, 'browser.form', seed, { latencyMs: candidateLatencies[seed]! }));
  }
  const result = await compare(store);
  assert.equal(result.matchedPairs, 4);
  assert.equal(result.baseline.p95TaskLatencyMs, 1000);
  assert.equal(result.candidate.p95TaskLatencyMs, 1100);
  assert.ok(result.improved.includes('averageLatencyMs'));
  assert.ok(result.improved.includes('p50TaskLatencyMs'));
  assert.ok(result.regressed.includes('p95TaskLatencyMs'));
});

test('matched tail latency thresholds can be configured without changing the run cohort', async t => {
  const store = await fixture(t);
  await store.recordRun(run(BASE, 'browser.form', 3, { latencyMs: 200 }));
  await store.recordRun(run(CANDIDATE, 'browser.form', 3, { latencyMs: 260 }));
  const result = await store.compareMatched({
    baselineSourceCommit: BASE,
    candidateSourceCommit: CANDIDATE,
    thresholds: { p95TaskLatencyMs: 100 }
  });
  assert.ok(!result.regressed.includes('p95TaskLatencyMs'));
  assert.ok(result.regressed.includes('averageLatencyMs'));
});
