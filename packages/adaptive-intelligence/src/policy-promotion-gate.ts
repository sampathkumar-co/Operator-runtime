import crypto from 'node:crypto';
import type { CalibrationReport } from './calibration.ts';
import type { IntelligenceMetrics } from './intelligence-metrics.ts';
import { validateShadowComparisonReport, type ShadowComparisonReport } from './shadow-comparison.ts';
import { canonicalJson } from './versioned-state.ts';

export interface PolicyPromotionCriteria {
  minPairedDecisions:number;
  minCandidateTasks:number;
  minBaselineTasks:number;
  minCalibrationSamples:number;
  minOutcomeCoverage:number;
  minProgressCoverage:number;
  minCostCoverage:number;
  minNetShadowWinRate:number;
  minMeanShadowProgressDelta:number;
  maxMeanShadowCostDelta:number;
  maxFalseGoalProgressRate:number;
  maxRepeatedEquivalentFailureRate:number;
  maxExpectedCalibrationError:number;
  maxBrierScore:number;
  maxFirstStrategySuccessRegression:number;
  maxRecoverySuccessRegression:number;
}

export interface PromotionGateCheck {
  id:string;
  ok:boolean;
  observed:number;
  requirement:string;
}

export interface PolicyPromotionEvidence {
  shadow:ShadowComparisonReport;
  candidateMetrics:IntelligenceMetrics;
  baselineMetrics:IntelligenceMetrics;
  calibration:CalibrationReport;
}

export interface PolicyPromotionAssessment {
  eligible:boolean;
  criteriaDigest:string;
  checks:PromotionGateCheck[];
  reasons:string[];
}

/**
 * Advisory release gate only. It does not mutate a policy, grant authority,
 * or promote a candidate. Production promotion remains an external,
 * independently authorized release action.
 */
export function assessPolicyPromotion(
  evidence:PolicyPromotionEvidence,
  criteriaInput:PolicyPromotionCriteria
):PolicyPromotionAssessment{
  if(!evidence||typeof evidence!=='object') throw new Error('policy promotion evidence is required.');
  const criteria=normalizeCriteria(criteriaInput);
  const shadow=validateShadowComparisonReport(evidence.shadow);
  const candidateMetrics=normalizeMetrics(evidence.candidateMetrics,'candidateMetrics');
  const baselineMetrics=normalizeMetrics(evidence.baselineMetrics,'baselineMetrics');
  const calibration=normalizeCalibration(evidence.calibration);
  const checks:PromotionGateCheck[]=[
    check('paired-decisions',shadow.pairedDecisions>=criteria.minPairedDecisions,shadow.pairedDecisions,'>= '+criteria.minPairedDecisions),
    check('candidate-task-sample',candidateMetrics.taskCount>=criteria.minCandidateTasks,candidateMetrics.taskCount,'>= '+criteria.minCandidateTasks),
    check('baseline-task-sample',baselineMetrics.taskCount>=criteria.minBaselineTasks,baselineMetrics.taskCount,'>= '+criteria.minBaselineTasks),
    check('calibration-sample',calibration.samples>=criteria.minCalibrationSamples,calibration.samples,'>= '+criteria.minCalibrationSamples),
    check('outcome-coverage',shadow.outcomeCoverage>=criteria.minOutcomeCoverage,shadow.outcomeCoverage,'>= '+criteria.minOutcomeCoverage),
    check('progress-coverage',shadow.progressCoverage>=criteria.minProgressCoverage,shadow.progressCoverage,'>= '+criteria.minProgressCoverage),
    check('cost-coverage',shadow.costCoverage>=criteria.minCostCoverage,shadow.costCoverage,'>= '+criteria.minCostCoverage),
    check(
      'net-shadow-win-rate',
      shadow.shadowWinRate-shadow.controlWinRate>=criteria.minNetShadowWinRate,
      round(shadow.shadowWinRate-shadow.controlWinRate),
      '>= '+criteria.minNetShadowWinRate
    ),
    check(
      'mean-shadow-progress-delta',
      shadow.meanShadowProgressDelta>=criteria.minMeanShadowProgressDelta,
      shadow.meanShadowProgressDelta,
      '>= '+criteria.minMeanShadowProgressDelta
    ),
    check(
      'mean-shadow-cost-delta',
      shadow.meanShadowCostDelta<=criteria.maxMeanShadowCostDelta,
      shadow.meanShadowCostDelta,
      '<= '+criteria.maxMeanShadowCostDelta
    ),
    check(
      'false-goal-progress-rate',
      candidateMetrics.falseGoalProgressRate<=criteria.maxFalseGoalProgressRate,
      candidateMetrics.falseGoalProgressRate,
      '<= '+criteria.maxFalseGoalProgressRate
    ),
    check(
      'repeated-equivalent-failure-rate',
      candidateMetrics.repeatedEquivalentFailureRate<=criteria.maxRepeatedEquivalentFailureRate,
      candidateMetrics.repeatedEquivalentFailureRate,
      '<= '+criteria.maxRepeatedEquivalentFailureRate
    ),
    check(
      'calibration-ece',
      calibration.expectedCalibrationError<=criteria.maxExpectedCalibrationError,
      calibration.expectedCalibrationError,
      '<= '+criteria.maxExpectedCalibrationError
    ),
    check(
      'calibration-brier',
      calibration.brierScore<=criteria.maxBrierScore,
      calibration.brierScore,
      '<= '+criteria.maxBrierScore
    ),
    check(
      'first-strategy-regression',
      baselineMetrics.firstStrategySuccessRate-candidateMetrics.firstStrategySuccessRate<=criteria.maxFirstStrategySuccessRegression,
      round(baselineMetrics.firstStrategySuccessRate-candidateMetrics.firstStrategySuccessRate),
      '<= '+criteria.maxFirstStrategySuccessRegression
    ),
    check(
      'recovery-regression',
      baselineMetrics.recoverySuccessRate-candidateMetrics.recoverySuccessRate<=criteria.maxRecoverySuccessRegression,
      round(baselineMetrics.recoverySuccessRate-candidateMetrics.recoverySuccessRate),
      '<= '+criteria.maxRecoverySuccessRegression
    )
  ];

  const failed=checks.filter(item=>!item.ok);
  return{
    eligible:failed.length===0,
    criteriaDigest:crypto.createHash('sha256').update(canonicalJson(criteria)).digest('hex'),
    checks,
    reasons:failed.map(item=>item.id+' failed: observed '+item.observed+'; required '+item.requirement)
  };
}

function check(id:string,ok:boolean,observed:number,requirement:string):PromotionGateCheck{
  return{id,ok,observed:round(observed),requirement};
}

function normalizeCriteria(input:PolicyPromotionCriteria):PolicyPromotionCriteria{
  if(!input||typeof input!=='object') throw new Error('promotion criteria are required.');
  return{
    minPairedDecisions:integer(input.minPairedDecisions,1,10_000_000,'minPairedDecisions'),
    minCandidateTasks:integer(input.minCandidateTasks,1,10_000_000,'minCandidateTasks'),
    minBaselineTasks:integer(input.minBaselineTasks,1,10_000_000,'minBaselineTasks'),
    minCalibrationSamples:integer(input.minCalibrationSamples,1,100_000_000,'minCalibrationSamples'),
    minOutcomeCoverage:unit(input.minOutcomeCoverage,'minOutcomeCoverage'),
    minProgressCoverage:unit(input.minProgressCoverage,'minProgressCoverage'),
    minCostCoverage:unit(input.minCostCoverage,'minCostCoverage'),
    minNetShadowWinRate:boundedNumber(input.minNetShadowWinRate,-1,1,'minNetShadowWinRate'),
    minMeanShadowProgressDelta:boundedNumber(input.minMeanShadowProgressDelta,-1_000_000,1_000_000,'minMeanShadowProgressDelta'),
    maxMeanShadowCostDelta:boundedNumber(input.maxMeanShadowCostDelta,-1_000_000,1_000_000,'maxMeanShadowCostDelta'),
    maxFalseGoalProgressRate:unit(input.maxFalseGoalProgressRate,'maxFalseGoalProgressRate'),
    maxRepeatedEquivalentFailureRate:unit(input.maxRepeatedEquivalentFailureRate,'maxRepeatedEquivalentFailureRate'),
    maxExpectedCalibrationError:unit(input.maxExpectedCalibrationError,'maxExpectedCalibrationError'),
    maxBrierScore:unit(input.maxBrierScore,'maxBrierScore'),
    maxFirstStrategySuccessRegression:unit(input.maxFirstStrategySuccessRegression,'maxFirstStrategySuccessRegression'),
    maxRecoverySuccessRegression:unit(input.maxRecoverySuccessRegression,'maxRecoverySuccessRegression')
  };
}
function normalizeMetrics(input:IntelligenceMetrics,label:string):IntelligenceMetrics{
  if(!input||typeof input!=='object') throw new Error(label+' is required.');
  return{
    taskCount:integer(input.taskCount,0,10_000_000,label+'.taskCount'),
    firstStrategySuccessRate:unit(input.firstStrategySuccessRate,label+'.firstStrategySuccessRate'),
    recoverySuccessRate:unit(input.recoverySuccessRate,label+'.recoverySuccessRate'),
    falseGoalProgressRate:unit(input.falseGoalProgressRate,label+'.falseGoalProgressRate'),
    repeatedEquivalentFailureRate:unit(input.repeatedEquivalentFailureRate,label+'.repeatedEquivalentFailureRate'),
    averageStepsPerTask:nonnegative(input.averageStepsPerTask,label+'.averageStepsPerTask')
  };
}
function normalizeCalibration(input:CalibrationReport):CalibrationReport{
  if(!input||typeof input!=='object') throw new Error('calibration report is required.');
  return{
    samples:integer(input.samples,0,100_000_000,'calibration.samples'),
    brierScore:unit(input.brierScore,'calibration.brierScore'),
    expectedCalibrationError:unit(input.expectedCalibrationError,'calibration.expectedCalibrationError'),
    meanPrediction:unit(input.meanPrediction,'calibration.meanPrediction'),
    empiricalSuccess:unit(input.empiricalSuccess,'calibration.empiricalSuccess'),
    buckets:Array.isArray(input.buckets)?structuredClone(input.buckets):(()=>{throw new Error('calibration.buckets is invalid.');})()
  };
}
function nonnegative(input:unknown,label:string):number{
  if (typeof input !== 'number') throw new Error(label + ' must be a number.');
  const value = input;
  if(!Number.isFinite(value)||value<0) throw new Error(label+' must be nonnegative.');
  return value;
}
function boundedNumber(input:unknown,min:number,max:number,label:string):number{
  if (typeof input !== 'number') throw new Error(label + ' must be a number.');
  const value = input;
  if(!Number.isFinite(value)||value<min||value>max) throw new Error(label+' is invalid.');
  return value;
}
function unit(input:unknown,label:string):number{return boundedNumber(input,0,1,label);}
function integer(input:unknown,min:number,max:number,label:string):number{
  if (typeof input !== 'number') throw new Error(label + ' must be a number.');
  const value = input;
  if(!Number.isSafeInteger(value)||value<min||value>max) throw new Error(label+' is invalid.');
  return value;
}
function round(value:number):number{return Math.round(value*1_000_000)/1_000_000;}
