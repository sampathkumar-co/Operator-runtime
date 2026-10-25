import assert from 'node:assert/strict';
import test from 'node:test';
import { compareMatchedPerformance } from '../scripts/c09-compare-performance.mjs';

const sha = ch => ch.repeat(64);
function sample(id, stageTimingsMs, endToEndMs = 100) {
  return {
    scenarioId: id, seed: 27, arm: 'mecord', modelVersion: 'frozen-model',
    stageTimingsMs, endToEndMs, claimedSuccess: true, verifiedSuccess: true,
    humanInterventions: 0, unauthorizedOperations: 0, uncertainReplays: 0, costMicros: 10
  };
}
function campaign(commit, records) {
  return {
    sourceCommit: commit, fixtureDigest: sha('1'), modelConfigDigest: sha('2'),
    controllerDigest: sha('3'), authorizationDigest: sha('4'),
    scorerDigest: sha('5'), environmentDigest: sha('6'), records
  };
}
test('C09 equal aggregate telemetry cannot conceal losing relay stage from a matched journey', () => {
  const before = campaign('a'.repeat(40), [
    sample('first', { relay: 8, provider: 10 }),
    sample('second', { provider: 12 })
  ]);
  const after = campaign('b'.repeat(40), [
    sample('first', { provider: 10 }),
    sample('second', { relay: 8, provider: 12 })
  ]);
  const result = compareMatchedPerformance({ baseline: before, candidate: after });
  assert.equal(result.baseline.stageMs.relay.observed, 1);
  assert.equal(result.candidate.stageMs.relay.observed, 1);
  assert.equal(result.regressionDiagnostics.missingStageInstrumentation.length, 0);
  assert.equal(result.regressionDiagnostics.lostStageInstrumentationJourneys, 1);
  assert.deepEqual(result.regressionDiagnostics.reasons, ['MATCHED_JOURNEY_STAGE_TELEMETRY_LOSS']);
  assert.equal(result.observedCandidateNotWorse, false);
  assert.equal(result.releaseAcceptance, 'NOT_ACCEPTED');
});

test('C09 adding observation stages without dropping any journey remains eligible for diagnostics', () => {
  const before = campaign('a'.repeat(40), [
    sample('first', { provider: 10 }),
    sample('second', { provider: 12 })
  ]);
  const after = campaign('b'.repeat(40), [
    sample('first', { relay: 8, provider: 10 }),
    sample('second', { provider: 12 })
  ]);
  const result = compareMatchedPerformance({ baseline: before, candidate: after });
  assert.equal(result.regressionDiagnostics.lostStageInstrumentationJourneys, 0);
  assert.equal(result.observedCandidateNotWorse, true);
});
