import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEvaluationFreezeManifest,
  createTaskCohortManifest,
  validatePolicyPromotionEvidenceBundle,
  type EvaluationFreezeManifest,
  type PolicyPromotionCriteria,
  type PolicyPromotionEvidenceBundle
} from '../packages/adaptive-intelligence/src/index.ts';
import { deriveR2GeneralPromotionEvidence } from '../scripts/derive-r2-promotion-evidence.ts';
import { assertPromotionEligible } from '../src/core/adaptive-planning-control.ts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
const E = 'e'.repeat(64);
const RECEIPT = 'f'.repeat(64);
const RUN = 'r2-general-evidence-run';
const TASK_IDS = Array.from({ length: 1_000 }, (_, index) => 'task-' + String(index).padStart(4, '0'));

function manifest(policyVersion: string, policyDigest: string, adaptiveDigest: string, benchmark = false): EvaluationFreezeManifest {
  return createEvaluationFreezeManifest({
    sourceRevision: '1'.repeat(40),
    intelligencePolicyVersion: policyVersion,
    intelligencePolicyDigest: policyDigest,
    adaptiveStateDigest: adaptiveDigest,
    authorityPolicyDigest: A,
    procedureSnapshotDigest: B,
    modelProvider: 'provider',
    modelId: 'model',
    modelConfigDigest: C,
    environmentId: 'representative-production-shadow',
    environmentDigest: D,
    runnerDigest: E,
    ...(benchmark ? { benchmarkId: 'forbidden-benchmark', benchmarkDigest: A } : {}),
    seed: 7
  }, { clock: () => new Date('2026-10-06T00:00:00.000Z') });
}

function criteria(overrides: Partial<PolicyPromotionCriteria> = {}): PolicyPromotionCriteria {
  return {
    minPairedDecisions: 10_000,
    minCandidateTasks: 1_000,
    minBaselineTasks: 1_000,
    minCalibrationSamples: 1_000,
    minOutcomeCoverage: 0.9,
    minProgressCoverage: 0.8,
    minCostCoverage: 0.8,
    minNetShadowWinRate: 0.05,
    minMeanShadowProgressDelta: 0,
    maxMeanShadowCostDelta: 0.1,
    maxFalseGoalProgressRate: 0.02,
    maxRepeatedEquivalentFailureRate: 0.1,
    maxExpectedCalibrationError: 0.1,
    maxBrierScore: 0.2,
    maxFirstStrategySuccessRegression: 0.02,
    maxRecoverySuccessRegression: 0.02,
    ...overrides
  };
}

function bundle(benchmark = false): PolicyPromotionEvidenceBundle {
  const taskCohort = createTaskCohortManifest(TASK_IDS);
  const candidate = manifest('candidate-r2', A, B, benchmark);
  const baseline = manifest('baseline-r2', B, C, benchmark);
  const candidateMetrics = {
    evaluationRunId: RUN,
    taskCohortDigest: taskCohort.cohortDigest,
    taskCount: 1_000,
    firstStrategySuccessRate: 0.82,
    recoverySuccessRate: 0.80,
    falseGoalProgressRate: 0.004,
    repeatedEquivalentFailureRate: 0.03,
    averageStepsPerTask: 7.8
  };
  const baselineMetrics = {
    evaluationRunId: RUN,
    taskCohortDigest: taskCohort.cohortDigest,
    taskCount: 1_000,
    firstStrategySuccessRate: 0.80,
    recoverySuccessRate: 0.75,
    falseGoalProgressRate: 0.005,
    repeatedEquivalentFailureRate: 0.04,
    averageStepsPerTask: 8
  };
  const calibration = {
    samples: 1_000,
    brierScore: 0.08,
    expectedCalibrationError: 0.04,
    meanPrediction: 0.73,
    empiricalSuccess: 0.69,
    buckets: [{
      lower: 0,
      upper: 1,
      count: 1_000,
      meanPrediction: 0.73,
      empiricalSuccess: 0.69,
      absoluteGap: 0.04
    }]
  };
  const shadow = {
    evaluationRunId: RUN,
    taskCohortDigest: taskCohort.cohortDigest,
    shadowPolicyVersion: candidate.intelligencePolicyVersion,
    controlPolicyVersion: baseline.intelligencePolicyVersion,
    pairedDecisions: 10_000,
    pairedOutcomeDecisions: 9_500,
    outcomeCoverage: 0.95,
    progressCoverage: 0.9,
    costCoverage: 0.9,
    agreementRate: 0.6,
    divergenceRate: 0.4,
    shadowWinRate: 0.25,
    controlWinRate: 0.1,
    tiedOutcomeRate: 0.65,
    meanShadowProgressDelta: 0.08,
    meanShadowCostDelta: -0.05,
    unmatchedShadow: 0,
    unmatchedControl: 0
  };

  return {
    taskCohort,
    candidateManifest: candidate,
    baselineManifest: baseline,
    candidateMetrics: {
      runId: RUN,
      evaluationManifestDigest: candidate.manifestDigest,
      policyVersion: candidate.intelligencePolicyVersion,
      taskCohortDigest: taskCohort.cohortDigest,
      value: candidateMetrics
    },
    baselineMetrics: {
      runId: RUN,
      evaluationManifestDigest: baseline.manifestDigest,
      policyVersion: baseline.intelligencePolicyVersion,
      taskCohortDigest: taskCohort.cohortDigest,
      value: baselineMetrics
    },
    calibration: {
      runId: RUN,
      evaluationManifestDigest: candidate.manifestDigest,
      policyVersion: candidate.intelligencePolicyVersion,
      taskCohortDigest: taskCohort.cohortDigest,
      value: calibration
    },
    shadow: {
      runId: RUN,
      candidateManifestDigest: candidate.manifestDigest,
      baselineManifestDigest: baseline.manifestDigest,
      candidatePolicyVersion: candidate.intelligencePolicyVersion,
      baselinePolicyVersion: baseline.intelligencePolicyVersion,
      taskCohortDigest: taskCohort.cohortDigest,
      report: shadow
    }
  };
}

function operational(input: PolicyPromotionEvidenceBundle) {
  const validated = validatePolicyPromotionEvidenceBundle(input);
  return {
    evaluationLineageDigest: validated.lineageDigest,
    authorityExpansionCount: 0,
    unsafeReplayCount: 0,
    deterministicRestartVerified: true,
    rollbackSnapshotDigest: D,
    verificationReceiptDigests: [RECEIPT],
    evaluatedAt: '2026-10-06T00:10:00.000Z'
  };
}

test('R2 GENERAL promotion evidence is derived only from a frozen non-benchmark lineage and remains core-gate eligible', () => {
  const input = bundle();
  const evidence = deriveR2GeneralPromotionEvidence({
    bundle: input,
    criteria: criteria(),
    operational: operational(input)
  });

  assert.equal(evidence.representativeShadowDecisions, 10_000);
  assert.equal(evidence.representativeTaskCount, 1_000);
  assert.equal(evidence.benchmarkExcluded, true);
  assert.equal(evidence.authorityExpansionCount, 0);
  assert.equal(evidence.unsafeReplayCount, 0);
  assert.equal(evidence.verifiedOutcomeDelta, 0.15);
  assert.match(evidence.evaluationLineageDigest, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => assertPromotionEligible('GENERAL', evidence));
});

test('R2 GENERAL promotion bridge refuses benchmark-derived evidence even when statistics are excellent', () => {
  const input = bundle(true);
  assert.throws(() => deriveR2GeneralPromotionEvidence({
    bundle: input,
    criteria: criteria(),
    operational: operational(input)
  }), /non-benchmark evaluation cohort/);
});

test('R2 GENERAL promotion bridge refuses criteria that undercut the 10,000 decision or 1,000 task threshold', () => {
  const input = bundle();
  assert.throws(() => deriveR2GeneralPromotionEvidence({
    bundle: input,
    criteria: criteria({ minPairedDecisions: 9_999 }),
    operational: operational(input)
  }), /10,000 paired decisions/);
  assert.throws(() => deriveR2GeneralPromotionEvidence({
    bundle: input,
    criteria: criteria({ minCandidateTasks: 999 }),
    operational: operational(input)
  }), /1,000 candidate and baseline tasks/);
});

test('R2 GENERAL operational proof must be bound to the exact frozen evaluation lineage', () => {
  const input = bundle();
  assert.throws(() => deriveR2GeneralPromotionEvidence({
    bundle: input,
    criteria: criteria(),
    operational: { ...operational(input), evaluationLineageDigest: '0'.repeat(64) }
  }), /not bound to the validated evaluation lineage/);
});
