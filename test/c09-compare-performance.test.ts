import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compareMatchedPerformance } from '../scripts/c09-compare-performance.mjs';
const D = c => c.repeat(64);
function sample(time = 100, overrides = {}) {
  return { scenarioId: 'safe_mock_form', seed: 42, arm: 'mecord',
    modelVersion: 'fixture-model-1', endToEndMs: time,
    stageTimingsMs: { mcpEdge: 5, relay: 8, authority: 4, provider: time - 27,
      verification: 5, resultCommit: 5 },
    claimedSuccess: true, verifiedSuccess: true, humanInterventions: 0,
    unauthorizedOperations: 0, uncertainReplays: 0, costMicros: 20,
    ...overrides
  };
}
const make = (time = 100, overrides = {}) => ({
  sourceCommit: 'a'.repeat(40), fixtureDigest: D('b'), modelConfigDigest: D('c'),
  controllerDigest: D('d'), authorizationDigest: D('e'), scorerDigest: D('f'),
  environmentDigest: D('1'), records: [sample(time)], ...overrides
});
test('C09 matched source/fixture/seed comparison records latency and preserves independent acceptance limits', () => {
  const r = compareMatchedPerformance({
    baseline: make(100), candidate: make(80, { sourceCommit: '9'.repeat(40) })
  });
  assert.equal(r.matchedRecordCount, 1);
  assert.equal(r.baseline.p95Ms, 100);
  assert.equal(r.candidate.p95Ms, 80);
  assert.equal(r.observedCandidateNotWorse, true);
  assert.equal(r.sourceTruth, 'SELF_REPORTED_INPUT_NOT_AUTHENTICATED');
  assert.equal(r.releaseAcceptance, 'NOT_ACCEPTED');
});
test('C09 comparable cases must use exactly the same seed, model version, intent and environment', () => {
  assert.throws(() => compareMatchedPerformance({
    baseline: make(), candidate: make(90, { records: [sample(90, { seed: 43 })] })
  }), /scenario\/seed\/model identity mismatch/);
  assert.throws(() => compareMatchedPerformance({
    baseline: make(), candidate: make(90, { environmentDigest: D('2') })
  }), /not comparable: environmentDigest/);
});
test('C09 lower latency cannot hide false completion, unsafe replay or lost verified task success', () => {
  const r = compareMatchedPerformance({
    baseline: make(100),
    candidate: make(60, { records: [sample(60, { verifiedSuccess: false, uncertainReplays: 1 })] })
  });
  assert.equal(r.candidate.falseCompletionCount, 1);
  assert.equal(r.candidate.uncertainReplays, 1);
  assert.equal(r.observedCandidateNotWorse, false);
  assert.equal(r.releaseAcceptance, 'NOT_ACCEPTED');
});
test('C09 invalid negative/stage-overflow values, hidden fields and duplicated records fail closed', () => {
  assert.throws(() => compareMatchedPerformance({
    baseline: make(), candidate: make(80, { records: [sample(80, { endToEndMs: -1 })] })
  }), /end-to-end duration/);
  assert.throws(() => compareMatchedPerformance({
    baseline: make(), candidate: make(80, { records: [sample(80, { stageTimingsMs: { provider: 900 } })] })
  }), /stage totals exceed/);
  assert.throws(() => compareMatchedPerformance({
    baseline: make(), candidate: make(80, { records: [sample(80, { password: 'secret-not-permitted' })] })
  }), /unexpected record field/);
  assert.throws(() => compareMatchedPerformance({
    baseline: make(), candidate: make(80, { records: [sample(80), sample(80)] })
  }), /duplicate journey/);
});

test('C09 refuses cost totals that exceed JavaScript exact-integer precision', () => {
  const rows = Array.from({ length: 9_008 }, (_, i) => sample(90, {
    scenarioId: `cost_scenario_${i}`, costMicros: 1_000_000_000_000
  }));
  assert.throws(() => compareMatchedPerformance({
    baseline: make(90, { records: rows }),
    candidate: make(90, { sourceCommit: '9'.repeat(40), records: rows })
  }), /aggregate counter overflow: costMicros/);
});

test('C09 rejects unapproved raw fields in top-level campaign metadata', () => {
  assert.throws(() => compareMatchedPerformance({
    baseline: make(), candidate: make(90, { apiKey: 'never-accept-secret-material' })
  }), /unexpected campaign field/);
});

test('C09 CLI refuses oversized evidence before reading arbitrary JSON into memory', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c09-size-cap-'));
  t.after(async () => fs.rm(dir, { recursive: true, force: true }));
  const oversized = path.join(dir, 'oversized.json');
  const valid = path.join(dir, 'valid.json');
  const handle = await fs.open(oversized, 'w');
  try { await handle.truncate(32 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await fs.writeFile(valid, JSON.stringify(make()));
  const run = spawnSync(process.execPath,
    ['scripts/c09-compare-performance.mjs', oversized, valid],
    { encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.error, undefined);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /input campaign file size invalid/);
});
