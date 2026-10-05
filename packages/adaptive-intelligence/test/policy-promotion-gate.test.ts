import assert from 'node:assert/strict';
import test from 'node:test';
import { assessPolicyPromotion } from '../src/index.ts';
import type {
  CalibrationReport,
  IntelligenceMetrics,
  PolicyPromotionCriteria,
  ShadowComparisonReport
} from '../src/index.ts';

function criteria():PolicyPromotionCriteria{
  return{
    minPairedDecisions:100,
    minOutcomeCoverage:0.9,
    minProgressCoverage:0.8,
    minCostCoverage:0.8,
    minNetShadowWinRate:0.05,
    minMeanShadowProgressDelta:0,
    maxMeanShadowCostDelta:0.1,
    maxFalseGoalProgressRate:0.02,
    maxRepeatedEquivalentFailureRate:0.1,
    maxExpectedCalibrationError:0.1,
    maxBrierScore:0.2,
    maxFirstStrategySuccessRegression:0.02,
    maxRecoverySuccessRegression:0.02
  };
}

function shadow(overrides:Partial<ShadowComparisonReport>={}):ShadowComparisonReport{
  return{
    pairedDecisions:200,
    pairedOutcomeDecisions:190,
    outcomeCoverage:0.95,
    progressCoverage:0.9,
    costCoverage:0.9,
    agreementRate:0.6,
    divergenceRate:0.4,
    shadowWinRate:0.25,
    controlWinRate:0.1,
    tiedOutcomeRate:0.65,
    meanShadowProgressDelta:0.08,
    meanShadowCostDelta:-0.05,
    unmatchedShadow:0,
    unmatchedControl:0,
    ...overrides
  };
}

function metrics(overrides:Partial<IntelligenceMetrics>={}):IntelligenceMetrics{
  return{
    taskCount:200,
    firstStrategySuccessRate:0.8,
    recoverySuccessRate:0.75,
    falseGoalProgressRate:0.005,
    repeatedEquivalentFailureRate:0.04,
    averageStepsPerTask:8,
    ...overrides
  };
}

function calibration(overrides:Partial<CalibrationReport>={}):CalibrationReport{
  return{
    samples:200,
    brierScore:0.08,
    expectedCalibrationError:0.04,
    meanPrediction:0.7,
    empiricalSuccess:0.69,
    buckets:[],
    ...overrides
  };
}

test('well-supported shadow candidate is eligible only as an advisory release result',()=>{
  const result=assessPolicyPromotion({
    shadow:shadow(),
    candidateMetrics:metrics({firstStrategySuccessRate:0.82,recoverySuccessRate:0.78}),
    baselineMetrics:metrics(),
    calibration:calibration()
  },criteria());
  assert.equal(result.eligible,true);
  assert.deepEqual(result.reasons,[]);
  assert.match(result.criteriaDigest,/^[0-9a-f]{64}$/);
});

test('high apparent shadow win rate cannot pass with sparse verified outcomes',()=>{
  const result=assessPolicyPromotion({
    shadow:shadow({
      shadowWinRate:0.8,
      controlWinRate:0.05,
      pairedOutcomeDecisions:20,
      outcomeCoverage:0.1
    }),
    candidateMetrics:metrics(),
    baselineMetrics:metrics(),
    calibration:calibration()
  },criteria());
  assert.equal(result.eligible,false);
  assert.ok(result.reasons.some(reason=>reason.startsWith('outcome-coverage failed')));
});

test('candidate is blocked on false progress even when shadow outcomes look better',()=>{
  const result=assessPolicyPromotion({
    shadow:shadow(),
    candidateMetrics:metrics({falseGoalProgressRate:0.08}),
    baselineMetrics:metrics(),
    calibration:calibration()
  },criteria());
  assert.equal(result.eligible,false);
  assert.ok(result.reasons.some(reason=>reason.startsWith('false-goal-progress-rate failed')));
});

test('candidate is blocked when confidence calibration is poor',()=>{
  const result=assessPolicyPromotion({
    shadow:shadow(),
    candidateMetrics:metrics(),
    baselineMetrics:metrics(),
    calibration:calibration({expectedCalibrationError:0.22,brierScore:0.3})
  },criteria());
  assert.equal(result.eligible,false);
  assert.ok(result.reasons.some(reason=>reason.startsWith('calibration-ece failed')));
  assert.ok(result.reasons.some(reason=>reason.startsWith('calibration-brier failed')));
});

test('candidate is blocked on meaningful first-strategy or recovery regression',()=>{
  const result=assessPolicyPromotion({
    shadow:shadow(),
    candidateMetrics:metrics({firstStrategySuccessRate:0.7,recoverySuccessRate:0.65}),
    baselineMetrics:metrics({firstStrategySuccessRate:0.8,recoverySuccessRate:0.75}),
    calibration:calibration()
  },criteria());
  assert.equal(result.eligible,false);
  assert.ok(result.reasons.some(reason=>reason.startsWith('first-strategy-regression failed')));
  assert.ok(result.reasons.some(reason=>reason.startsWith('recovery-regression failed')));
});
