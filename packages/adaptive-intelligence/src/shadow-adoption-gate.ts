import type { IntelligenceMetrics } from './intelligence-metrics.ts';
import type { ShadowComparisonReport } from './shadow-comparison.ts';

export interface ShadowAdoptionThresholds {
  minPairedDecisions:number;
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

export function assessShadowAdoption(
  comparison:ShadowComparisonReport,
  metrics:IntelligenceMetrics,
  thresholdsInput:Partial<ShadowAdoptionThresholds>={}
):ShadowAdoptionAssessment{
  const thresholds:ShadowAdoptionThresholds={
    minPairedDecisions:integer(thresholdsInput.minPairedDecisions??100,1,1_000_000,'minPairedDecisions'),
    minShadowWinRate:unit(thresholdsInput.minShadowWinRate??0.15,'minShadowWinRate'),
    maxControlWinRate:unit(thresholdsInput.maxControlWinRate??0.10,'maxControlWinRate'),
    minMeanShadowProgressDelta:number(thresholdsInput.minMeanShadowProgressDelta??0,'minMeanShadowProgressDelta'),
    maxMeanShadowCostDelta:number(thresholdsInput.maxMeanShadowCostDelta??0.10,'maxMeanShadowCostDelta'),
    maxFalseGoalProgressRate:unit(thresholdsInput.maxFalseGoalProgressRate??0.01,'maxFalseGoalProgressRate'),
    maxRepeatedEquivalentFailureRate:unit(thresholdsInput.maxRepeatedEquivalentFailureRate??0.05,'maxRepeatedEquivalentFailureRate'),
    minRecoverySuccessRate:unit(thresholdsInput.minRecoverySuccessRate??0.5,'minRecoverySuccessRate')
  };
  const checks=[
    check('paired-decisions',comparison.pairedDecisions,thresholds.minPairedDecisions,'>='),
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

function check(name:string,actual:number,threshold:number,operator:'>='|'<='){
  return{name,actual,threshold,operator,ok:operator==='>='?actual>=threshold:actual<=threshold};
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
