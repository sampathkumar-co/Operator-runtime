import type { ProgressLevel, TrajectoryStep } from './contracts.ts';

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

  let firstStrategySuccesses=0;
  let recoveryOpportunities=0;
  let recoverySuccesses=0;
  let claimedGoalProgress=0;
  let falseGoalProgress=0;
  let repeatedFailureEvents=0;
  let failureEvents=0;
  let totalSteps=0;

  for(const record of records){
    totalSteps+=record.steps.length;
    if(record.steps.length>0 && record.finalVerifiedSuccess && successfulProgress(record.steps[0]!.progress.level)){
      firstStrategySuccesses+=1;
    }

    let hadFailure=false;
    const failedFamilies=new Map<string,number>();
    for(const step of record.steps){
      const failed=Boolean(step.failure)||!step.outcome.ok||step.delta.expectedEffectsMissing.length>0;
      if(failed){
        failureEvents+=1;
        hadFailure=true;
        const count=(failedFamilies.get(step.action.family)??0)+1;
        failedFamilies.set(step.action.family,count);
        if(count>=2) repeatedFailureEvents+=1;
      }
      if(step.progress.level==='GOAL_ACHIEVED'){
        claimedGoalProgress+=1;
        if(!record.finalVerifiedSuccess) falseGoalProgress+=1;
      }
    }
    if(hadFailure){
      recoveryOpportunities+=1;
      if(record.finalVerifiedSuccess) recoverySuccesses+=1;
    }
  }

  return {
    taskCount:records.length,
    firstStrategySuccessRate:round(firstStrategySuccesses/records.length),
    recoverySuccessRate:round(recoverySuccesses/Math.max(1,recoveryOpportunities)),
    falseGoalProgressRate:round(falseGoalProgress/Math.max(1,claimedGoalProgress)),
    repeatedEquivalentFailureRate:round(repeatedFailureEvents/Math.max(1,failureEvents)),
    averageStepsPerTask:round(totalSteps/records.length)
  };
}

function successfulProgress(level:ProgressLevel):boolean{
  return level==='SUBGOAL_PROGRESS'||level==='GOAL_ACHIEVED';
}
function normalizeRecord(input:TaskTrajectoryRecord):TaskTrajectoryRecord{
  if(!input||typeof input!=='object') throw new Error('task trajectory record is required.');
  const taskId=String(input.taskId??'');
  if(!taskId||taskId.length>512) throw new Error('taskId is invalid.');
  if(!Array.isArray(input.steps)||input.steps.length>100000) throw new Error('steps are invalid.');
  return {taskId,steps:structuredClone(input.steps),finalVerifiedSuccess:Boolean(input.finalVerifiedSuccess)};
}
function round(value:number):number{return Math.round(value*1_000_000)/1_000_000;}
