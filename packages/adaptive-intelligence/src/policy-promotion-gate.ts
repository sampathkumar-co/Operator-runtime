import crypto from 'node:crypto';
import type { CalibrationReport } from './calibration.ts';
import type { IntelligenceMetrics } from './intelligence-metrics.ts';
import type { ShadowComparisonReport } from './shadow-comparison.ts';
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
  const criteria=normalizeCriteria(criteriaInput);
  const checks:PromotionGateCheck[]=[
    check('paired-decisions',evidence.shadow.pairedDecisions>=criteria.minPairedDecisions,evidence.shadow.pairedDecisions,'>= '+criteria.minPairedDecisions),
    check('candidate-task-sample',evidence.candidateMetrics.taskCount>=criteria.minCandidateTasks,evidence.candidateMetrics.taskCount,'>= '+criteria.minCandidateTasks),
    check('baseline-task-sample',evidence.baselineMetrics.taskCount>=criteria.minBaselineTasks,evidence.baselineMetrics.taskCount,'>= '+criteria.minBaselineTasks),
    check('calibration-sample',evidence.calibration.samples>=criteria.minCalibrationSamples,evidence.calibration.samples,'>= '+criteria.minCalibrationSamples),
    check('outcome-coverage',evidence.shadow.outcomeCoverage>=criteria.minOutcomeCoverage,evidence.shadow.outcomeCoverage,'>= '+criteria.minOutcomeCoverage),
    check('progress-coverage',evidence.shadow.progressCoverage>=criteria.minProgressCoverage,evidence.shadow.progressCoverage,'>= '+criteria.minProgressCoverage),
    check('cost-coverage',evidence.shadow.costCoverage>=criteria.minCostCoverage,evidence.shadow.costCoverage,'>= '+criteria.minCostCoverage),
    check(
      'net-shadow-win-rate',
      evidence.shadow.shadowWinRate-evidence.shadow.controlWinRate>=criteria.minNetShadowWinRate,
      round(evidence.shadow.shadowWinRate-evidence.shadow.controlWinRate),
      '>= '+criteria.minNetShadowWinRate
    ),
    check(
      'mean-shadow-progress-delta',
      evidence.shadow.meanShadowProgressDelta>=criteria.minMeanShadowProgressDelta,
      evidence.shadow.meanShadowProgressDelta,
      '>= '+criteria.minMeanShadowProgressDelta
    ),
    check(
      'mean-shadow-cost-delta',
      evidence.shadow.meanShadowCostDelta<=criteria.maxMeanShadowCostDelta,
      evidence.shadow.meanShadowCostDelta,
      '<= '+criteria.maxMeanShadowCostDelta
    ),
    check(
      'false-goal-progress-rate',
      evidence.candidateMetrics.falseGoalProgressRate<=criteria.maxFalseGoalProgressRate,
      evidence.candidateMetrics.falseGoalProgressRate,
      '<= '+criteria.maxFalseGoalProgressRate
    ),
    check(
      'repeated-equivalent-failure-rate',
      evidence.candidateMetrics.repeatedEquivalentFailureRate<=criteria.maxRepeatedEquivalentFailureRate,
      evidence.candidateMetrics.repeatedEquivalentFailureRate,
      '<= '+criteria.maxRepeatedEquivalentFailureRate
    ),
    check(
      'calibration-ece',
      evidence.calibration.expectedCalibrationError<=criteria.maxExpectedCalibrationError,
      evidence.calibration.expectedCalibrationError,
      '<= '+criteria.maxExpectedCalibrationError
    ),
    check(
      'calibration-brier',
      evidence.calibration.brierScore<=criteria.maxBrierScore,
      evidence.calibration.brierScore,
      '<= '+criteria.maxBrierScore
    ),
    check(
      'first-strategy-regression',
      evidence.baselineMetrics.firstStrategySuccessRate-evidence.candidateMetrics.firstStrategySuccessRate<=criteria.maxFirstStrategySuccessRegression,
      round(evidence.baselineMetrics.firstStrategySuccessRate-evidence.candidateMetrics.firstStrategySuccessRate),
      '<= '+criteria.maxFirstStrategySuccessRegression
    ),
    check(
      'recovery-regression',
      evidence.baselineMetrics.recoverySuccessRate-evidence.candidateMetrics.recoverySuccessRate<=criteria.maxRecoverySuccessRegression,
      round(evidence.baselineMetrics.recoverySuccessRate-evidence.candidateMetrics.recoverySuccessRate),
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
function boundedNumber(input:unknown,min:number,max:number,label:string):number{
  const value=Number(input);
  if(!Number.isFinite(value)||value<min||value>max) throw new Error(label+' is invalid.');
  return value;
}
function unit(input:unknown,label:string):number{return boundedNumber(input,0,1,label);}
function integer(input:unknown,min:number,max:number,label:string):number{
  const value=Number(input);
  if(!Number.isSafeInteger(value)||value<min||value>max) throw new Error(label+' is invalid.');
  return value;
}
function round(value:number):number{return Math.round(value*1_000_000)/1_000_000;}
