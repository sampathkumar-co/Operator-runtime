import type { IntelligenceMetrics } from './intelligence-metrics.ts';
import { validateShadowComparisonReport, type ShadowComparisonReport } from './shadow-comparison.ts';

export interface ShadowAdoptionThresholds {
  minPairedDecisions:number;
  minTaskCount:number;
  minOutcomeCoverage:number;
  minProgressCoverage:number;
  minCostCoverage:number;
  maxUnmatchedDecisionRate:number;
  minShadowWinRate:number;
  maxControlWinRate:number;
  minMeanShadowProgressDelta:number;
  maxMeanShadowCostDelta:number;
  maxFalseGoalProgressRate:number;
  maxRepeatedEquivalentFailureRate:number;
  minRecoverySuccessRate:number;
}

export interface ShadowAdoptionAssessment {
  eligible:boolean;
  checks:Array<{name:string;ok:boolean;actual:number;threshold:number;operator:string}>;
  blockers:string[];
}

/**
 * Advisory gate for graduating a candidate beyond pure shadow observation.
 * This never promotes a policy or grants execution authority; the stronger
 * policy-promotion gate and normal release authorization remain required.
 */
export function assessShadowAdoption(
  comparisonInput:ShadowComparisonReport,
  metricsInput:IntelligenceMetrics,
  thresholdsInput:Partial<ShadowAdoptionThresholds>={}
):ShadowAdoptionAssessment{
  const comparison=validateShadowComparisonReport(comparisonInput);
  const metrics=normalizeMetrics(metricsInput);
  const thresholds:ShadowAdoptionThresholds={
    minPairedDecisions:integer(thresholdsInput.minPairedDecisions??100,1,1_000_000,'minPairedDecisions'),
    minTaskCount:integer(thresholdsInput.minTaskCount??100,1,1_000_000,'minTaskCount'),
    minOutcomeCoverage:unit(thresholdsInput.minOutcomeCoverage??0.9,'minOutcomeCoverage'),
    minProgressCoverage:unit(thresholdsInput.minProgressCoverage??0.8,'minProgressCoverage'),
    minCostCoverage:unit(thresholdsInput.minCostCoverage??0.8,'minCostCoverage'),
    maxUnmatchedDecisionRate:unit(thresholdsInput.maxUnmatchedDecisionRate??0.1,'maxUnmatchedDecisionRate'),
    minShadowWinRate:unit(thresholdsInput.minShadowWinRate??0.15,'minShadowWinRate'),
    maxControlWinRate:unit(thresholdsInput.maxControlWinRate??0.10,'maxControlWinRate'),
    minMeanShadowProgressDelta:number(thresholdsInput.minMeanShadowProgressDelta??0,'minMeanShadowProgressDelta'),
    maxMeanShadowCostDelta:number(thresholdsInput.maxMeanShadowCostDelta??0.10,'maxMeanShadowCostDelta'),
    maxFalseGoalProgressRate:unit(thresholdsInput.maxFalseGoalProgressRate??0.01,'maxFalseGoalProgressRate'),
    maxRepeatedEquivalentFailureRate:unit(thresholdsInput.maxRepeatedEquivalentFailureRate??0.05,'maxRepeatedEquivalentFailureRate'),
    minRecoverySuccessRate:unit(thresholdsInput.minRecoverySuccessRate??0.5,'minRecoverySuccessRate')
  };
  const unmatchedDecisionRate=computeUnmatchedDecisionRate(comparison);
  const checks=[
    check('paired-decisions',comparison.pairedDecisions,thresholds.minPairedDecisions,'>='),
    check('task-count',metrics.taskCount,thresholds.minTaskCount,'>='),
    check('outcome-coverage',comparison.outcomeCoverage,thresholds.minOutcomeCoverage,'>='),
    check('progress-coverage',comparison.progressCoverage,thresholds.minProgressCoverage,'>='),
    check('cost-coverage',comparison.costCoverage,thresholds.minCostCoverage,'>='),
    check('unmatched-decision-rate',unmatchedDecisionRate,thresholds.maxUnmatchedDecisionRate,'<='),
    check('shadow-win-rate',comparison.shadowWinRate,thresholds.minShadowWinRate,'>='),
    check('control-win-rate',comparison.controlWinRate,thresholds.maxControlWinRate,'<='),
    check('shadow-progress-delta',comparison.meanShadowProgressDelta,thresholds.minMeanShadowProgressDelta,'>='),
    check('shadow-cost-delta',comparison.meanShadowCostDelta,thresholds.maxMeanShadowCostDelta,'<='),
    check('false-goal-progress-rate',metrics.falseGoalProgressRate,thresholds.maxFalseGoalProgressRate,'<='),
    check('repeated-equivalent-failure-rate',metrics.repeatedEquivalentFailureRate,thresholds.maxRepeatedEquivalentFailureRate,'<='),
    check('recovery-success-rate',metrics.recoverySuccessRate,thresholds.minRecoverySuccessRate,'>=')
  ];
  const blockers=checks.filter(item=>!item.ok).map(item=>item.name);
  return {eligible:blockers.length===0,checks,blockers};
}

function computeUnmatchedDecisionRate(comparison:ShadowComparisonReport):number{
  const unmatched=comparison.unmatchedShadow+comparison.unmatchedControl;
  const total=comparison.pairedDecisions*2+unmatched;
  return total===0?0:round(unmatched/total);
}
function normalizeMetrics(input:IntelligenceMetrics):IntelligenceMetrics{
  if(!input||typeof input!=='object') throw new Error('intelligence metrics are required.');
  return{
    taskCount:integer(input.taskCount,0,10_000_000,'metrics.taskCount'),
    firstStrategySuccessRate:unit(input.firstStrategySuccessRate,'metrics.firstStrategySuccessRate'),
    recoverySuccessRate:unit(input.recoverySuccessRate,'metrics.recoverySuccessRate'),
    falseGoalProgressRate:unit(input.falseGoalProgressRate,'metrics.falseGoalProgressRate'),
    repeatedEquivalentFailureRate:unit(input.repeatedEquivalentFailureRate,'metrics.repeatedEquivalentFailureRate'),
    averageStepsPerTask:nonnegative(input.averageStepsPerTask,'metrics.averageStepsPerTask')
  };
}
function check(name:string,actual:number,threshold:number,operator:'>='|'<='){
  return{name,actual:round(actual),threshold,operator,ok:operator==='>='?actual>=threshold:actual<=threshold};
}
function integer(input:unknown,min:number,max:number,label:string):number{
  const value=Number(input);
  if(!Number.isSafeInteger(value)||value<min||value>max) throw new Error(label+' is invalid.');
  return value;
}
function unit(input:unknown,label:string):number{
  const value=Number(input);
  if(!Number.isFinite(value)||value<0||value>1) throw new Error(label+' must be between 0 and 1.');
  return value;
}
function number(input:unknown,label:string):number{
  const value=Number(input);
  if(!Number.isFinite(value)) throw new Error(label+' is invalid.');
  return value;
}
function nonnegative(input:unknown,label:string):number{
  const value=number(input,label);
  if(value<0) throw new Error(label+' must be nonnegative.');
  return value;
}
function round(value:number):number{return Math.round(value*1_000_000)/1_000_000;}
