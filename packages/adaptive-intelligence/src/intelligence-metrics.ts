import type { TrajectoryStep } from './contracts.ts';
import { strategyFingerprint } from './strategy-engine.ts';

export interface IntelligenceMetrics {
  taskCount:number;
  firstStrategySuccessRate:number;
  recoverySuccessRate:number;
  falseGoalProgressRate:number;
  repeatedEquivalentFailureRate:number;
  averageStepsPerTask:number;
}

export interface TaskTrajectoryRecord {
  taskId:string;
  steps:TrajectoryStep[];
  finalVerifiedSuccess:boolean;
}

export function computeIntelligenceMetrics(recordsInput:TaskTrajectoryRecord[]):IntelligenceMetrics{
  if(!Array.isArray(recordsInput)||recordsInput.length>100000) throw new Error('records are invalid.');
  const records=recordsInput.map(normalizeRecord);
  if(records.length===0) return {
    taskCount:0,
    firstStrategySuccessRate:0,
    recoverySuccessRate:0,
    falseGoalProgressRate:0,
    repeatedEquivalentFailureRate:0,
    averageStepsPerTask:0
  };

  let cleanFirstStrategySuccesses=0;
  let recoveryOpportunities=0;
  let recoverySuccesses=0;
  let claimedGoalProgress=0;
  let falseGoalProgress=0;
  let repeatedFailureEvents=0;
  let failureEvents=0;
  let totalSteps=0;

  for(const record of records){
    totalSteps+=record.steps.length;
    let hadFailure=false;
    const failedStrategies=new Map<string,number>();

    for(const step of record.steps){
      const failed=isFailedStep(step);
      if(failed){
        failureEvents+=1;
        hadFailure=true;
        const fingerprint=failureFingerprint(step);
        const count=(failedStrategies.get(fingerprint)??0)+1;
        failedStrategies.set(fingerprint,count);
        if(count>=2) repeatedFailureEvents+=1;
      }
      if(step.progress.level==='GOAL_ACHIEVED'){
        claimedGoalProgress+=1;
        if(!record.finalVerifiedSuccess) falseGoalProgress+=1;
      }
    }

    // "First strategy success" is intentionally conservative: the task
    // reached independently verified success without any failure/recovery
    // event in its trajectory. A merely promising first action does not count.
    if(record.finalVerifiedSuccess && !hadFailure) cleanFirstStrategySuccesses+=1;

    if(hadFailure){
      recoveryOpportunities+=1;
      if(record.finalVerifiedSuccess) recoverySuccesses+=1;
    }
  }

  return {
    taskCount:records.length,
    firstStrategySuccessRate:round(cleanFirstStrategySuccesses/records.length),
    recoverySuccessRate:round(recoverySuccesses/Math.max(1,recoveryOpportunities)),
    falseGoalProgressRate:round(falseGoalProgress/Math.max(1,claimedGoalProgress)),
    repeatedEquivalentFailureRate:round(repeatedFailureEvents/Math.max(1,failureEvents)),
    averageStepsPerTask:round(totalSteps/records.length)
  };
}

function isFailedStep(step:TrajectoryStep):boolean{
  return Boolean(step.failure)||!step.outcome.ok||step.delta.expectedEffectsMissing.length>0;
}
function failureFingerprint(step:TrajectoryStep):string{
  return strategyFingerprint({
    family:step.action.strategyId ? 'strategy:'+step.action.strategyId : step.action.family,
    requiresFacts:[],
    expectedEffects:step.action.expectedEffects??[]
  });
}
function normalizeRecord(input:TaskTrajectoryRecord):TaskTrajectoryRecord{
  if(!input||typeof input!=='object') throw new Error('task trajectory record is required.');
  const taskId=String(input.taskId??'');
  if(!taskId||taskId.length>512) throw new Error('taskId is invalid.');
  if(!Array.isArray(input.steps)||input.steps.length>100000) throw new Error('steps are invalid.');
  return {taskId,steps:structuredClone(input.steps),finalVerifiedSuccess:Boolean(input.finalVerifiedSuccess)};
}
function round(value:number):number{return Math.round(value*1_000_000)/1_000_000;}
