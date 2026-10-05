import crypto from 'node:crypto';
import { validateCalibrationReport, type CalibrationReport } from './calibration.ts';
import {
  verifyEvaluationFreezeManifest,
  type EvaluationFreezeManifest
} from './evaluation-freeze.ts';
import type { IntelligenceMetrics } from './intelligence-metrics.ts';
import {
  verifyTaskCohortManifest,
  type TaskCohortManifest
} from './evaluation-cohort.ts';
import {
  assessPolicyPromotion,
  type PolicyPromotionAssessment,
  type PolicyPromotionCriteria
} from './policy-promotion-gate.ts';
import {
  validateShadowComparisonReport,
  type ShadowComparisonReport
} from './shadow-comparison.ts';
import { canonicalJson } from './versioned-state.ts';

export interface BoundAggregate<T> {
  runId:string;
  evaluationManifestDigest:string;
  policyVersion:string;
  taskCohortDigest:string;
  value:T;
}

export interface BoundShadowEvidence {
  runId:string;
  candidateManifestDigest:string;
  baselineManifestDigest:string;
  candidatePolicyVersion:string;
  baselinePolicyVersion:string;
  taskCohortDigest:string;
  report:ShadowComparisonReport;
}

export interface PolicyPromotionEvidenceBundle {
  taskCohort:TaskCohortManifest;
  candidateManifest:EvaluationFreezeManifest;
  baselineManifest:EvaluationFreezeManifest;
  candidateMetrics:BoundAggregate<IntelligenceMetrics>;
  baselineMetrics:BoundAggregate<IntelligenceMetrics>;
  calibration:BoundAggregate<CalibrationReport>;
  shadow:BoundShadowEvidence;
}

export interface ValidatedPolicyPromotionEvidenceBundle extends PolicyPromotionEvidenceBundle {
  lineageDigest:string;
}

export interface BoundPolicyPromotionAssessment extends PolicyPromotionAssessment {
  lineageDigest:string;
  candidateManifestDigest:string;
  baselineManifestDigest:string;
}

export function validatePolicyPromotionEvidenceBundle(
  input:PolicyPromotionEvidenceBundle
):ValidatedPolicyPromotionEvidenceBundle{
  if(!input||typeof input!=='object') throw new Error('policy promotion evidence bundle is required.');
  const taskCohort=verifiedTaskCohort(input.taskCohort);
  const candidateManifest=verifiedManifest(input.candidateManifest,'candidateManifest');
  const baselineManifest=verifiedManifest(input.baselineManifest,'baselineManifest');
  assertComparableEvaluationContext(candidateManifest,baselineManifest);

  const shadow=normalizeShadowBinding(input.shadow,candidateManifest,baselineManifest);
  if(shadow.taskCohortDigest!==taskCohort.cohortDigest){
    throw new Error('Shadow evidence task cohort does not match the canonical task cohort manifest.');
  }
  const candidateMetrics=normalizeAggregate(
    input.candidateMetrics,
    candidateManifest,
    shadow.runId,
    shadow.taskCohortDigest,
    'candidateMetrics',
    normalizeMetrics
  );
  const baselineMetrics=normalizeAggregate(
    input.baselineMetrics,
    baselineManifest,
    shadow.runId,
    shadow.taskCohortDigest,
    'baselineMetrics',
    normalizeMetrics
  );
  const calibration=normalizeAggregate(
    input.calibration,
    candidateManifest,
    shadow.runId,
    shadow.taskCohortDigest,
    'calibration',
    validateCalibrationReport
  );

  if(candidateMetrics.value.taskCount!==taskCohort.taskCount){
    throw new Error('Candidate metrics task count does not match the canonical task cohort.');
  }
  if(baselineMetrics.value.taskCount!==taskCohort.taskCount){
    throw new Error('Baseline metrics task count does not match the canonical task cohort.');
  }

  const normalized:PolicyPromotionEvidenceBundle={
    taskCohort,
    candidateManifest,
    baselineManifest,
    candidateMetrics,
    baselineMetrics,
    calibration,
    shadow
  };
  const lineageDigest=crypto.createHash('sha256').update(canonicalJson(normalized)).digest('hex');
  return{...normalized,lineageDigest};
}

export function assessBoundPolicyPromotion(
  bundleInput:PolicyPromotionEvidenceBundle,
  criteria:PolicyPromotionCriteria
):BoundPolicyPromotionAssessment{
  const bundle=validatePolicyPromotionEvidenceBundle(bundleInput);
  const assessment=assessPolicyPromotion({
    shadow:bundle.shadow.report,
    candidateMetrics:bundle.candidateMetrics.value,
    baselineMetrics:bundle.baselineMetrics.value,
    calibration:bundle.calibration.value
  },criteria);
  return{
    ...assessment,
    lineageDigest:bundle.lineageDigest,
    candidateManifestDigest:bundle.candidateManifest.manifestDigest,
    baselineManifestDigest:bundle.baselineManifest.manifestDigest
  };
}

function verifiedTaskCohort(input:TaskCohortManifest):TaskCohortManifest{
  if(!verifyTaskCohortManifest(input)) throw new Error('taskCohort failed cohort-manifest verification.');
  return structuredClone(input);
}

function verifiedManifest(
  input:EvaluationFreezeManifest,
  label:string
):EvaluationFreezeManifest{
  if(!verifyEvaluationFreezeManifest(input)) throw new Error(label+' failed freeze-manifest verification.');
  return structuredClone(input);
}

function assertComparableEvaluationContext(
  candidate:EvaluationFreezeManifest,
  baseline:EvaluationFreezeManifest
):void{
  const fields:Array<keyof EvaluationFreezeManifest>=[
    'modelProvider',
    'modelId',
    'modelConfigDigest',
    'environmentId',
    'environmentDigest',
    'runnerDigest',
    'benchmarkId',
    'benchmarkDigest',
    'seed',
    'authorityPolicyDigest',
    'procedureSnapshotDigest'
  ];
  for(const field of fields){
    if((candidate[field]??null)!==(baseline[field]??null)){
      throw new Error('Candidate/baseline evaluation context mismatch: '+String(field)+'.');
    }
  }
}

function normalizeShadowBinding(
  input:BoundShadowEvidence,
  candidate:EvaluationFreezeManifest,
  baseline:EvaluationFreezeManifest
):BoundShadowEvidence{
  if(!input||typeof input!=='object') throw new Error('shadow evidence binding is required.');
  const runId=bounded(input.runId,512,'shadow.runId');
  const candidateManifestDigest=sha256(input.candidateManifestDigest,'shadow.candidateManifestDigest');
  const baselineManifestDigest=sha256(input.baselineManifestDigest,'shadow.baselineManifestDigest');
  const candidatePolicyVersion=bounded(input.candidatePolicyVersion,256,'shadow.candidatePolicyVersion');
  const baselinePolicyVersion=bounded(input.baselinePolicyVersion,256,'shadow.baselinePolicyVersion');
  const taskCohortDigest=sha256(input.taskCohortDigest,'shadow.taskCohortDigest');
  if(candidateManifestDigest!==candidate.manifestDigest) throw new Error('Shadow candidate manifest binding mismatch.');
  if(baselineManifestDigest!==baseline.manifestDigest) throw new Error('Shadow baseline manifest binding mismatch.');
  if(candidatePolicyVersion!==candidate.intelligencePolicyVersion) throw new Error('Shadow candidate policy version mismatch.');
  if(baselinePolicyVersion!==baseline.intelligencePolicyVersion) throw new Error('Shadow baseline policy version mismatch.');
  return{
    runId,
    candidateManifestDigest,
    baselineManifestDigest,
    candidatePolicyVersion,
    baselinePolicyVersion,
    taskCohortDigest,
    report:validateShadowComparisonReport(input.report)
  };
}

function normalizeAggregate<T>(
  input:BoundAggregate<T>,
  manifest:EvaluationFreezeManifest,
  expectedRunId:string,
  expectedTaskCohortDigest:string,
  label:string,
  validate:(value:T)=>T
):BoundAggregate<T>{
  if(!input||typeof input!=='object') throw new Error(label+' binding is required.');
  const runId=bounded(input.runId,512,label+'.runId');
  const evaluationManifestDigest=sha256(input.evaluationManifestDigest,label+'.evaluationManifestDigest');
  const policyVersion=bounded(input.policyVersion,256,label+'.policyVersion');
  const taskCohortDigest=sha256(input.taskCohortDigest,label+'.taskCohortDigest');
  if(runId!==expectedRunId) throw new Error(label+' is bound to a different evaluation run.');
  if(evaluationManifestDigest!==manifest.manifestDigest) throw new Error(label+' manifest binding mismatch.');
  if(policyVersion!==manifest.intelligencePolicyVersion) throw new Error(label+' policy version mismatch.');
  if(taskCohortDigest!==expectedTaskCohortDigest) throw new Error(label+' task cohort mismatch.');
  return{
    runId,
    evaluationManifestDigest,
    policyVersion,
    taskCohortDigest,
    value:validate(input.value)
  };
}

function normalizeMetrics(input:IntelligenceMetrics):IntelligenceMetrics{
  if(!input||typeof input!=='object') throw new Error('bound intelligence metrics are required.');
  return{
    taskCount:integer(input.taskCount,0,10_000_000,'metrics.taskCount'),
    firstStrategySuccessRate:unit(input.firstStrategySuccessRate,'metrics.firstStrategySuccessRate'),
    recoverySuccessRate:unit(input.recoverySuccessRate,'metrics.recoverySuccessRate'),
    falseGoalProgressRate:unit(input.falseGoalProgressRate,'metrics.falseGoalProgressRate'),
    repeatedEquivalentFailureRate:unit(input.repeatedEquivalentFailureRate,'metrics.repeatedEquivalentFailureRate'),
    averageStepsPerTask:nonnegative(input.averageStepsPerTask,'metrics.averageStepsPerTask')
  };
}
function bounded(input:unknown,max:number,label:string):string{
  if(typeof input!=='string') throw new Error(label+' must be a string.');
  if(!input||input.length>max) throw new Error(label+' is invalid.');
  return input;
}
function sha256(input:unknown,label:string):string{
  if(typeof input!=='string') throw new Error(label+' must be a string.');
  const value=input.toLowerCase();
  if(!/^[0-9a-f]{64}$/.test(value)) throw new Error(label+' must be SHA-256.');
  return value;
}
function integer(input:unknown,min:number,max:number,label:string):number{
  if(typeof input!=='number') throw new Error(label+' must be a number.');
  if(!Number.isSafeInteger(input)||input<min||input>max) throw new Error(label+' is invalid.');
  return input;
}
function unit(input:unknown,label:string):number{
  if(typeof input!=='number') throw new Error(label+' must be a number.');
  if(!Number.isFinite(input)||input<0||input>1) throw new Error(label+' must be between 0 and 1.');
  return input;
}
function nonnegative(input:unknown,label:string):number{
  if(typeof input!=='number'||!Number.isFinite(input)||input<0) throw new Error(label+' must be nonnegative.');
  return input;
}
