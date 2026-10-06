import crypto from 'node:crypto';
import { canonicalJson } from './versioned-state.ts';

export const TASK_COHORT_SCHEMA='mecord.adaptive-intelligence.task-cohort';
export const TASK_COHORT_VERSION=1;

export interface TaskCohortManifest {
  schema:typeof TASK_COHORT_SCHEMA;
  version:typeof TASK_COHORT_VERSION;
  taskIds:string[];
  taskCount:number;
  cohortDigest:string;
}

export function createTaskCohortManifest(taskIdsInput:string[]):TaskCohortManifest{
  if(!Array.isArray(taskIdsInput)||taskIdsInput.length<1||taskIdsInput.length>1_000_000){
    throw new Error('task cohort must contain 1-1000000 task ids.');
  }
  const taskIds=taskIdsInput.map((item)=>bounded(item,512,'taskId'));
  if(new Set(taskIds).size!==taskIds.length){
    throw new Error('task cohort task ids must be unique.');
  }
  taskIds.sort();
  const base={
    schema:TASK_COHORT_SCHEMA,
    version:TASK_COHORT_VERSION,
    taskIds,
    taskCount:taskIds.length
  };
  return{
    ...base,
    cohortDigest:digestBase(base)
  };
}

export function verifyTaskCohortManifest(input:TaskCohortManifest):boolean{
  try{
    if(!input||typeof input!=='object') return false;
    if(input.schema!==TASK_COHORT_SCHEMA||input.version!==TASK_COHORT_VERSION) return false;
    if(!Array.isArray(input.taskIds)||input.taskIds.length<1||input.taskIds.length>1_000_000) return false;
    const taskIds=input.taskIds.map((item)=>bounded(item,512,'taskId'));
    if(new Set(taskIds).size!==taskIds.length) return false;
    const sorted=[...taskIds].sort();
    if(sorted.some((item,index)=>item!==taskIds[index])) return false;
    if(typeof input.taskCount!=='number'||!Number.isSafeInteger(input.taskCount)||input.taskCount!==taskIds.length){
      return false;
    }
    const supplied=sha256(input.cohortDigest,'cohortDigest');
    const expected=digestBase({
      schema:TASK_COHORT_SCHEMA,
      version:TASK_COHORT_VERSION,
      taskIds,
      taskCount:taskIds.length
    });
    return timingSafeHexEqual(expected,supplied);
  }catch{
    return false;
  }
}

function digestBase(input:{
  schema:typeof TASK_COHORT_SCHEMA;
  version:typeof TASK_COHORT_VERSION;
  taskIds:string[];
  taskCount:number;
}):string{
  return crypto.createHash('sha256').update(canonicalJson(input)).digest('hex');
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
function timingSafeHexEqual(a:string,b:string):boolean{
  const aa=Buffer.from(a,'hex'),bb=Buffer.from(b,'hex');
  return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);
}
