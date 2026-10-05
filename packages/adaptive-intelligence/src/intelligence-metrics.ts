import type { TrajectoryStep, VerificationReceiptRef } from './contracts.ts';
import { strategyFingerprint } from './strategy-engine.ts';

export interface IntelligenceMetrics {
  taskCount:number;
  firstStrategySuccessRate:number;
  recoverySuccessRate:number;
  falseGoalProgressRate:number;
  repeatedEquivalentFailureRate:number;
  averageStepsPerTask:number;
}

export interface TaskVerificationReceiptRef extends VerificationReceiptRef {
  runId:string;
  taskId:string;
}

export interface TaskTrajectoryRecord {
  runId:string;
  taskId:string;
  goalId:string;
  steps:TrajectoryStep[];
  finalVerificationReceipt?:TaskVerificationReceiptRef;
}

interface NormalizedTaskTrajectoryRecord extends TaskTrajectoryRecord {
  finalVerificationReceipt?:TaskVerificationReceiptRef;
}

export function computeIntelligenceMetrics(
  recordsInput:TaskTrajectoryRecord[],
  options:{now?:Date}={}
):IntelligenceMetrics{
  if(!Array.isArray(recordsInput)||recordsInput.length>100000) throw new Error('records are invalid.');
  const now=options.now??new Date();
  const records=recordsInput.map(record=>normalizeRecord(record,now));
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
    const finalVerifiedSuccess=Boolean(record.finalVerificationReceipt);
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
        if(!finalVerifiedSuccess) falseGoalProgress+=1;
      }
    }

    // "First strategy success" is intentionally conservative: the task
    // reached independently verified success without any failure/recovery
    // event in its trajectory. A merely promising first action does not count.
    if(finalVerifiedSuccess && !hadFailure) cleanFirstStrategySuccesses+=1;

    if(hadFailure){
      recoveryOpportunities+=1;
      if(finalVerifiedSuccess) recoverySuccesses+=1;
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
function normalizeRecord(input:TaskTrajectoryRecord,now:Date):NormalizedTaskTrajectoryRecord{
  if(!input||typeof input!=='object') throw new Error('task trajectory record is required.');
  const runId=bounded(input.runId,512,'runId');
  const taskId=bounded(input.taskId,512,'taskId');
  const goalId=bounded(input.goalId,256,'goalId');
  if(!Array.isArray(input.steps)||input.steps.length>100000) throw new Error('steps are invalid.');
  const finalVerificationReceipt=input.finalVerificationReceipt
    ? normalizeVerificationReceipt(input.finalVerificationReceipt,runId,taskId,goalId,now)
    : undefined;
  return {
    runId,
    taskId,
    goalId,
    steps:structuredClone(input.steps),
    ...(finalVerificationReceipt?{finalVerificationReceipt}:{})
  };
}
function normalizeVerificationReceipt(
  input:TaskVerificationReceiptRef,
  runId:string,
  taskId:string,
  goalId:string,
  now:Date
):TaskVerificationReceiptRef{
  if(!input||typeof input!=='object') throw new Error('final verification receipt is invalid.');
  const verifiedAt=validIso(input.verifiedAt,'finalVerificationReceipt.verifiedAt');
  if(Date.parse(verifiedAt)>now.getTime()) throw new Error('Final verification receipt cannot be future-dated.');
  const normalized:TaskVerificationReceiptRef={
    digest:sha256(input.digest,'finalVerificationReceipt.digest'),
    runId:bounded(input.runId,512,'finalVerificationReceipt.runId'),
    taskId:bounded(input.taskId,512,'finalVerificationReceipt.taskId'),
    goalId:bounded(input.goalId,256,'finalVerificationReceipt.goalId'),
    verifierId:bounded(input.verifierId,512,'finalVerificationReceipt.verifierId'),
    verifiedAt,
    authoritySnapshotDigest:sha256(input.authoritySnapshotDigest,'finalVerificationReceipt.authoritySnapshotDigest')
  };
  if(normalized.runId!==runId) throw new Error('Final verification receipt is bound to a different run.');
  if(normalized.taskId!==taskId) throw new Error('Final verification receipt is bound to a different task.');
  if(normalized.goalId!==goalId) throw new Error('Final verification receipt is bound to a different goal.');
  return normalized;
}
function bounded(input:unknown,max:number,label:string):string{
  if (typeof input !== 'string') throw new Error(label + ' must be a string.');
  const value = input;
  if(!value||value.length>max) throw new Error(label+' is invalid.');
  return value;
}
function sha256(input:unknown,label:string):string{
  if (typeof input !== 'string') throw new Error(label + ' must be a string.');
  const value = input.toLowerCase();
  if(!/^[0-9a-f]{64}$/.test(value)) throw new Error(label+' must be SHA-256.');
  return value;
}
function validIso(input:unknown,label:string):string{
  if (typeof input !== 'string') throw new Error(label + ' must be a string.');
  const value = input;
  const parsed=Date.parse(value);
  if(!Number.isFinite(parsed)||new Date(parsed).toISOString()!==value) throw new Error(label+' must be ISO timestamp.');
  return value;
}
function round(value:number):number{return Math.round(value*1_000_000)/1_000_000;}
