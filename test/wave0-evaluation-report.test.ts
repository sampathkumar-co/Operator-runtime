import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildWave0EvaluationReport } from '../scripts/wave0-evaluation.mjs';

const sourceCommit = 'a'.repeat(40);
const d = (char = 'b') => char.repeat(64);
function record(lane, arm, overrides = {}) {
  return {
    lane, arm, sourceCommit, id: 'run_' + lane + '_' + arm,
    scenarioId: 'generic_fixture', scenarioVersion: '1', seed: 0,
    model: lane === 'B' ? 'scripted' : 'example_model',
    provider: lane === 'A' ? 'none' : arm,
    runnerDigest: d(), modelConfigDigest: d('c'), environmentDigest: d('d'),
    independentOracleDigest: d('e'), resultEvidenceDigest: d('f'),
    claimedSuccess: false, verifiedSuccess: false, failureStage: 'model',
    latencyMs: 100, costMicros: 0, humanInterventions: 0, unauthorizedEffects: 0,
    ...overrides
  };
}
test('no run means NOT_RUN, no invented 0% success or claimed model pass', () => {
  const output = buildWave0EvaluationReport({ sourceCommit });
  for (const lane of ['A', 'B', 'C']) {
    assert.equal(output.lanes[lane].status, 'NOT_RUN');
    assert.equal(output.lanes[lane].evidence, null);
  }
  assert.equal(output.full125MiniWob, 'NOT_RUN');
  assert.equal(output.releaseAcceptance, 'NOT_ACCEPTED');
});

test('partial Lane B with false controller claim records false completion, not product success', () => {
  const output = buildWave0EvaluationReport({
    sourceCommit, records: [record('B', 'mecord_scripted', {
      model: 'scripted', claimedSuccess: true, verifiedSuccess: false, failureStage: 'verifier'
    })]
  });
  assert.equal(output.lanes.B.status, 'PARTIAL');
  assert.equal(output.lanes.B.evidence.falseCompletions, 1);
  assert.equal(output.lanes.B.evidence.verifiedCompletionRate, 0);
  assert.equal(output.lanes.A.status, 'NOT_RUN');
});

test('Lane A cannot smuggle in Mecord provider dispatch as model-only ability', () => {
  assert.throws(() => buildWave0EvaluationReport({ sourceCommit,
    records: [record('A', 'model_only', { provider: 'browser.cdp' })] }), /must not dispatch/);
});

test('Lane C requires perfectly paired model/prompt/seed/suite/environment identities', () => {
  const left = record('C', 'mecord');
  assert.throws(() => buildWave0EvaluationReport({ sourceCommit, records: [left] }), /not paired/);
  const right = record('C', 'direct', { id: 'run_C_direct' });
  const output = buildWave0EvaluationReport({ sourceCommit, records: [left, right] });
  assert.equal(output.lanes.C.status, 'PARTIAL');
  assert.equal(output.lanes.C.evidence.mecord.runs, 1);
  assert.equal(output.lanes.C.evidence.direct.runs, 1);
  assert.throws(() => buildWave0EvaluationReport({ sourceCommit, records: [
    left, { ...right, environmentDigest: d('1') }
  ] }), /not paired/);
});

test('invalid provenance or fake independent oracle digest is rejected', () => {
  assert.throws(() => buildWave0EvaluationReport({ sourceCommit,
    records: [record('B', 'mecord_scripted', { model: 'scripted', independentOracleDigest: 'not a sha' })]
  }), /immutable sha256/);
  assert.throws(() => buildWave0EvaluationReport({ sourceCommit,
    records: [record('B', 'mecord_scripted', { model: 'scripted', sourceCommit: 'f'.repeat(40) })]
  }), /does not match/);
});

test('complete suite coverage never claims release or physical acceptance by itself', () => {
  const ids = Array.from({ length: 50 }, (_, i) => 'scenario_' + i);
  const records = ids.map((id, i) => record('B', 'mecord_scripted', {
    id: 'run_' + i, scenarioId: id, model: 'scripted', seed: i
  }));
  const r = buildWave0EvaluationReport({ sourceCommit, records,
    preregistered: { suiteDigest: d('a'), expectedScenarioIds: ids } });
  assert.equal(r.lanes.B.status, 'REPORTED_FULL_COVERAGE_UNVERIFIED');
  assert.equal(r.lanes.B.physicalAcceptance, 'NOT_VERIFIED');
  assert.equal(r.releaseAcceptance, 'NOT_ACCEPTED');
  assert.equal(r.lanes.C.status, 'NOT_RUN');
});

test('unregistered or duplicate test suite must never be marked a completed campaign', () => {
  assert.throws(() => buildWave0EvaluationReport({ sourceCommit,
    preregistered: { suiteDigest: d('a'), expectedScenarioIds: ['small'] }
  }), /preregistered suite/);
  assert.throws(() => buildWave0EvaluationReport({ sourceCommit,
    records: [record('B', 'mecord_scripted', { model: 'scripted' }),
      record('B', 'mecord_scripted', { model: 'scripted', id: 'another' })]
  }), /duplicate evaluation identity/);
});

test('Lane A cannot masquerade scripted fixtures as independent model decisions', () => {
  assert.throws(() => buildWave0EvaluationReport({ sourceCommit, records: [
    record('A', 'model_only', { model: 'scripted' })
  ] }), /requires a named model/);
});

test('failed outcomes cannot silently use success-stage none as their root cause', () => {
  assert.throws(() => buildWave0EvaluationReport({ sourceCommit, records: [
    record('B', 'mecord_scripted', { model: 'scripted', failureStage: 'none' })
  ] }), /requires explicit failure attribution/);
  const passed = buildWave0EvaluationReport({ sourceCommit, records: [
    record('B', 'mecord_scripted', {
      model: 'scripted', verifiedSuccess: true, claimedSuccess: true, failureStage: 'none'
    })
  ] });
  assert.equal(passed.lanes.B.evidence.verifiedSuccesses, 1);
});

test('a fully registered suite with unattributed failures stays PARTIAL', () => {
  const ids = Array.from({ length: 50 }, (_, i) => 'journey_' + i);
  const runs = ids.map((scenarioId, i) => record('B', 'mecord_scripted', {
    model: 'scripted', scenarioId, id: 'run_' + i, seed: i,
    failureStage: i === 0 ? 'unattributed' : 'model'
  }));
  const r = buildWave0EvaluationReport({
    sourceCommit, records: runs,
    preregistered: { suiteDigest: d('a'), expectedScenarioIds: ids }
  });
  assert.equal(r.lanes.B.status, 'PARTIAL');
  assert.match(r.lanes.B.reason, /unattributed root cause/);
  assert.equal(r.lanes.B.evidence.unattributedFailures, 1);
  assert.equal(r.releaseAcceptance, 'NOT_ACCEPTED');
});

test('invalid preregistered scenario names are rejected instead of being treated as frozen identities', () => {
  const invalid = Array.from({ length: 50 }, (_, i) => 'journey_' + i);
  invalid[0] = { value: 'object-not-a-scenario-id' };
  assert.throws(() => buildWave0EvaluationReport({
    sourceCommit, preregistered: { suiteDigest: d('a'), expectedScenarioIds: invalid }
  }), /preregistered suite/);
});

test('C01 refuses fractional or precision-losing single-run cost counters', () => {
  for (const amount of [0.25, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buildWave0EvaluationReport({ sourceCommit,
      records: [record('B', 'mecord_scripted', { model: 'scripted', costMicros: amount })]
    }), /costMicros invalid or precision-losing/);
  }
});
test('C01 rejects campaign aggregate cost and unauthorized effect counter overflow', () => {
  const expensive = record('B', 'mecord_scripted', {
    model: 'scripted', costMicros: Number.MAX_SAFE_INTEGER,
    id: 'first', scenarioId: 'first'
  });
  const second = record('B', 'mecord_scripted', {
    model: 'scripted', costMicros: 1,
    id: 'second', scenarioId: 'second'
  });
  assert.throws(() => buildWave0EvaluationReport({
    sourceCommit, records: [expensive, second]
  }), /costMicros aggregate exceeds exact-integer range/);
  assert.throws(() => buildWave0EvaluationReport({ sourceCommit, records: [
    { ...expensive, costMicros: 0, unauthorizedEffects: Number.MAX_SAFE_INTEGER },
    { ...second, costMicros: 0, unauthorizedEffects: 1 }
  ] }), /unauthorizedEffects aggregate exceeds exact-integer range/);
});
test('C01 CLI bounds untrusted evidence files before parsing campaign data', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c01-eval-input-'));
  t.after(async () => fs.rm(dir, { recursive: true, force: true }));
  const tooLarge = path.join(dir, 'too-large.json');
  const handle = await fs.open(tooLarge, 'w');
  try { await handle.truncate(32 * 1024 * 1024 + 1); } finally { await handle.close(); }
  const run = spawnSync(process.execPath,
    ['scripts/wave0-evaluation-report.mjs', '--input', tooLarge],
    { encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.error, undefined);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /input evidence size invalid/);
});
