import assert from 'node:assert/strict';
import test from 'node:test';
import { compareMatchedPerformance } from '../scripts/c09-compare-performance.mjs';

const D = ch => ch.repeat(64);
function row(time, overrides = {}) {
  return {
    scenarioId: 'quality_integration', seed: 42, arm: 'mecord',
    modelVersion: 'fixture-1', endToEndMs: time,
    stageTimingsMs: { mcpEdge: 5, relay: 10, provider: 20, verification: 5 },
    claimedSuccess: true, verifiedSuccess: true,
    humanInterventions: 0, unauthorizedOperations: 0, uncertainReplays: 0,
    costMicros: 10,
    ...overrides
  };
}
function data(sourceCommit, rows) {
  return {
    sourceCommit, fixtureDigest: D('b'), modelConfigDigest: D('c'),
    controllerDigest: D('d'), authorizationDigest: D('e'), scorerDigest: D('f'),
    environmentDigest: D('1'), records: rows
  };
}

test('C09 missing stage samples are reported as unknown, never fabricated zero milliseconds', () => {
  const x = compareMatchedPerformance({
    baseline: data('a'.repeat(40), [row(100)]),
    candidate: data('9'.repeat(40), [row(90)])
  });
  assert.deepEqual(x.baseline.stageMs.journal, {
    observed: 0, missing: 1, p50: null, p95: null, p99: null
  });
  assert.deepEqual(x.baseline.stageMs.relay, {
    observed: 1, missing: 0, p50: 10, p95: 10, p99: 10
  });
  assert.equal(x.observedCandidateNotWorse, true);
});

test('C09 omitting observed relay timings cannot falsely improve performance', () => {
  const baseline = data('a'.repeat(40), [row(100)]);
  const candidate = data('9'.repeat(40), [row(80, {
    stageTimingsMs: { mcpEdge: 5, provider: 20, verification: 5 }
  })]);
  const x = compareMatchedPerformance({ baseline, candidate });
  assert.equal(x.candidate.stageMs.relay.observed, 0);
  assert.equal(x.candidate.stageMs.relay.missing, 1);
  assert.equal(x.candidate.stageMs.relay.p50, null);
  assert.deepEqual(x.regressionDiagnostics.missingStageInstrumentation, ['relay']);
  assert.deepEqual(x.regressionDiagnostics.reasons, ['STAGE_TELEMETRY_COVERAGE_REGRESSION']);
  assert.equal(x.observedCandidateNotWorse, false);
});

test('C09 full stage coverage is measured only from explicitly present values', () => {
  const a = data('a'.repeat(40), [
    row(100, { scenarioId: 'first' }),
    row(100, { scenarioId: 'second', stageTimingsMs: { mcpEdge: 4, relay: 6, provider: 15 } })
  ]);
  const b = data('9'.repeat(40), [
    row(80, { scenarioId: 'first' }),
    row(80, { scenarioId: 'second', stageTimingsMs: { mcpEdge: 4, relay: 6, provider: 15 } })
  ]);
  const x = compareMatchedPerformance({ baseline: a, candidate: b });
  assert.equal(x.baseline.stageMs.verification.observed, 1);
  assert.equal(x.baseline.stageMs.verification.missing, 1);
  assert.equal(x.baseline.stageMs.verification.p95, 5);
  assert.equal(x.observedCandidateNotWorse, true);
});
