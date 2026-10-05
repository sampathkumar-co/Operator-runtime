import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessBoundPolicyPromotion,
  createEvaluationFreezeManifest,
  validatePolicyPromotionEvidenceBundle
} from '../src/index.ts';
import type {
  EvaluationFreezeManifest,
  PolicyPromotionCriteria,
  PolicyPromotionEvidenceBundle
} from '../src/index.ts';

const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),D='d'.repeat(64);
const E='e'.repeat(64),F='f'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';
const RUN='promotion-run-1';

function manifest(policyVersion:string,policyDigest:string,adaptiveDigest:string):EvaluationFreezeManifest{
  return createEvaluationFreezeManifest({
    sourceRevision:'abcdef1',
    intelligencePolicyVersion:policyVersion,
    intelligencePolicyDigest:policyDigest,
    adaptiveStateDigest:adaptiveDigest,
    authorityPolicyDigest:A,
    procedureSnapshotDigest:B,
    modelProvider:'provider',
    modelId:'model',
    modelConfigDigest:C,
    environmentId:'env',
    environmentDigest:D,
    runnerDigest:E,
    benchmarkId:'suite',
    benchmarkDigest:F,
    seed:0
  },{clock:()=>new Date(T0)});
}

function metrics(){
  return{
    taskCount:200,
    firstStrategySuccessRate:0.8,
    recoverySuccessRate:0.75,
    falseGoalProgressRate:0.005,
    repeatedEquivalentFailureRate:0.04,
    averageStepsPerTask:8
  };
}

function calibration(){
  return{
    samples:200,
    brierScore:0.08,
    expectedCalibrationError:0.04,
    meanPrediction:0.73,
    empiricalSuccess:0.69,
    buckets:[{
      lower:0,
      upper:1,
      count:200,
      meanPrediction:0.73,
      empiricalSuccess:0.69,
      absoluteGap:0.04
    }]
  };
}

function shadow(){
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
    unmatchedControl:0
  };
}

function criteria():PolicyPromotionCriteria{
  return{
    minPairedDecisions:100,
    minCandidateTasks:100,
    minBaselineTasks:100,
    minCalibrationSamples:100,
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

function bundle():PolicyPromotionEvidenceBundle{
  const candidate=manifest('candidate-v2',A,B);
  const baseline=manifest('baseline-v1',B,C);
  return{
    candidateManifest:candidate,
    baselineManifest:baseline,
    candidateMetrics:{
      runId:RUN,
      evaluationManifestDigest:candidate.manifestDigest,
      policyVersion:candidate.intelligencePolicyVersion,
      value:{...metrics(),firstStrategySuccessRate:0.82,recoverySuccessRate:0.78}
    },
    baselineMetrics:{
      runId:RUN,
      evaluationManifestDigest:baseline.manifestDigest,
      policyVersion:baseline.intelligencePolicyVersion,
      value:metrics()
    },
    calibration:{
      runId:RUN,
      evaluationManifestDigest:candidate.manifestDigest,
      policyVersion:candidate.intelligencePolicyVersion,
      value:calibration()
    },
    shadow:{
      runId:RUN,
      candidateManifestDigest:candidate.manifestDigest,
      baselineManifestDigest:baseline.manifestDigest,
      candidatePolicyVersion:candidate.intelligencePolicyVersion,
      baselinePolicyVersion:baseline.intelligencePolicyVersion,
      report:shadow()
    }
  };
}

test('fully bound promotion evidence produces a stable lineage digest and advisory assessment',()=>{
  const one=validatePolicyPromotionEvidenceBundle(bundle());
  const two=validatePolicyPromotionEvidenceBundle(bundle());
  assert.match(one.lineageDigest,/^[0-9a-f]{64}$/);
  assert.equal(one.lineageDigest,two.lineageDigest);

  const assessment=assessBoundPolicyPromotion(bundle(),criteria());
  assert.equal(assessment.eligible,true);
  assert.equal(assessment.lineageDigest,one.lineageDigest);
  assert.match(assessment.candidateManifestDigest,/^[0-9a-f]{64}$/);
});

test('candidate metrics from another evaluation run are rejected',()=>{
  const input=bundle();
  input.candidateMetrics.runId='other-run';
  assert.throws(()=>validatePolicyPromotionEvidenceBundle(input),/different evaluation run/);
});

test('calibration cannot be detached from candidate manifest or policy',()=>{
  const input=bundle();
  input.calibration.evaluationManifestDigest=input.baselineManifest.manifestDigest;
  assert.throws(()=>validatePolicyPromotionEvidenceBundle(input),/calibration manifest binding mismatch/);

  const other=bundle();
  other.calibration.policyVersion='baseline-v1';
  assert.throws(()=>validatePolicyPromotionEvidenceBundle(other),/calibration policy version mismatch/);
});

test('shadow evidence cannot claim a different candidate manifest',()=>{
  const input=bundle();
  input.shadow.candidateManifestDigest=input.baselineManifest.manifestDigest;
  assert.throws(()=>validatePolicyPromotionEvidenceBundle(input),/Shadow candidate manifest binding mismatch/);
});

test('tampered evaluation freeze manifest is rejected before promotion statistics are considered',()=>{
  const input=bundle();
  input.candidateManifest={...input.candidateManifest,modelId:'tampered-model'};
  assert.throws(()=>validatePolicyPromotionEvidenceBundle(input),/failed freeze-manifest verification/);
});

test('candidate and baseline must share fair evaluation context',()=>{
  const input=bundle();
  input.baselineManifest=createEvaluationFreezeManifest({
    sourceRevision:'abcdef1',
    intelligencePolicyVersion:'baseline-v1',
    intelligencePolicyDigest:B,
    adaptiveStateDigest:C,
    authorityPolicyDigest:A,
    procedureSnapshotDigest:B,
    modelProvider:'provider',
    modelId:'different-model',
    modelConfigDigest:C,
    environmentId:'env',
    environmentDigest:D,
    runnerDigest:E,
    benchmarkId:'suite',
    benchmarkDigest:F,
    seed:0
  },{clock:()=>new Date(T0)});
  input.baselineMetrics.evaluationManifestDigest=input.baselineManifest.manifestDigest;
  input.shadow.baselineManifestDigest=input.baselineManifest.manifestDigest;
  assert.throws(()=>validatePolicyPromotionEvidenceBundle(input),/evaluation context mismatch: modelId/);
});

test('forged calibration cannot enter a bound promotion bundle',()=>{
  const input=bundle();
  input.calibration.value={
    ...input.calibration.value,
    expectedCalibrationError:0.001
  };
  assert.throws(()=>validatePolicyPromotionEvidenceBundle(input),/expectedCalibrationError mismatch/);
});


test('policy comparison cannot hide a different procedure-memory snapshot',()=>{
  const input=bundle();
  input.baselineManifest=createEvaluationFreezeManifest({
    sourceRevision:'abcdef1',
    intelligencePolicyVersion:'baseline-v1',
    intelligencePolicyDigest:B,
    adaptiveStateDigest:C,
    authorityPolicyDigest:A,
    procedureSnapshotDigest:E,
    modelProvider:'provider',
    modelId:'model',
    modelConfigDigest:C,
    environmentId:'env',
    environmentDigest:D,
    runnerDigest:E,
    benchmarkId:'suite',
    benchmarkDigest:F,
    seed:0
  },{clock:()=>new Date(T0)});
  input.baselineMetrics.evaluationManifestDigest=input.baselineManifest.manifestDigest;
  input.shadow.baselineManifestDigest=input.baselineManifest.manifestDigest;
  assert.throws(
    ()=>validatePolicyPromotionEvidenceBundle(input),
    /evaluation context mismatch: procedureSnapshotDigest/
  );
});
