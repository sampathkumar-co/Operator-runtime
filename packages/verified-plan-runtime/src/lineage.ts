import crypto from 'node:crypto';
import type { PlanDecisionLineage } from './contracts.ts';

export interface DecisionLineageInput {
  planId:string;
  planVersion:number;
  goalId:string;
  nodeId:string;
  beliefDigest:string;
  decisionKind:PlanDecisionLineage['decisionKind'];
  decisionId:string;
  createdAt?:string;
}

export function createDecisionLineage(input:DecisionLineageInput):PlanDecisionLineage{
  const createdAt=input.createdAt??new Date().toISOString();
  validIso(createdAt);
  const body={
    planId:bounded(input.planId,256,'planId'),
    planVersion:integer(input.planVersion,1,Number.MAX_SAFE_INTEGER,'planVersion'),
    goalId:bounded(input.goalId,256,'goalId'),
    nodeId:bounded(input.nodeId,256,'nodeId'),
    beliefDigest:sha256(input.beliefDigest,'beliefDigest'),
    decisionKind:input.decisionKind,
    decisionId:bounded(input.decisionId,512,'decisionId'),
    createdAt
  };
  const digest=crypto.createHash('sha256').update(canonical(body)).digest('hex');
  return {digest,...body};
}

export function digestBeliefs(input:unknown):string{
  return crypto.createHash('sha256').update(canonical(input)).digest('hex');
}

export function canonical(input:unknown):string{
  if(input===null||typeof input!=='object') return JSON.stringify(input);
  if(Array.isArray(input)) return '['+input.map(canonical).join(',')+']';
  const o=input as Record<string,unknown>;
  return '{'+Object.keys(o).sort().map((k)=>JSON.stringify(k)+':'+canonical(o[k])).join(',')+'}';
}
function bounded(v:unknown,m:number,l:string):string{if(typeof v!=='string'||!v||v.length>m)throw new Error(l+' is invalid.');return v;}
function sha256(v:unknown,l:string):string{if(typeof v!=='string'||!/^[0-9a-fA-F]{64}$/.test(v))throw new Error(l+' must be SHA-256.');return v.toLowerCase();}
function integer(v:unknown,min:number,max:number,l:string):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)throw new Error(l+' is invalid.');return v;}
function validIso(v:string):void{const p=Date.parse(v);if(!Number.isFinite(p)||new Date(p).toISOString()!==v)throw new Error('createdAt must be ISO timestamp.');}
