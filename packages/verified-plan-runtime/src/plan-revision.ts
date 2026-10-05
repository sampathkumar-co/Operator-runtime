import type { CompiledGoal, PlanGraph, PlanNodeState } from './contracts.ts';
import { dependentClosure, initializeNodeStates, validatePlanGraph } from './plan-graph.ts';
import { canonical, digestPlan } from './lineage.ts';
import crypto from 'node:crypto';

export interface PreservedNodeDigest {
  nodeId:string;
  nodeDigest:string;
}

export interface PlanRevisionProof {
  digest:string;
  planId:string;
  goalId:string;
  fromVersion:number;
  toVersion:number;
  fromPlanDigest:string;
  toPlanDigest:string;
  preservedNodeDigests:PreservedNodeDigest[];
  resetNodeIds:string[];
  createdAt:string;
}

export interface PlanRevisionResult {
  graph:PlanGraph;
  states:PlanNodeState[];
  changedNodeIds:string[];
  resetNodeIds:string[];
  preservedSucceededNodeIds:string[];
  proof:PlanRevisionProof;
}

export function revisePlan(
  goal:CompiledGoal,
  previous:PlanGraph,
  previousStates:PlanNodeState[],
  nextInput:PlanGraph,
  now=new Date().toISOString()
):PlanRevisionResult{
  validIso(now,'now');
  if(previousStates.some((s)=>s.status==='RUNNING')){
    throw new Error('plan revision is forbidden while an execution node is running.');
  }
  if(previousStates.some((s)=>s.status==='BLOCKED'&&Boolean(s.lastExecutionDigest))){
    throw new Error('plan revision is forbidden while an execution is awaiting verification.');
  }
  const next=validatePlanGraph(goal,nextInput);
  if(next.planId!==previous.planId||next.goalId!==previous.goalId){
    throw new Error('plan revision must preserve plan and goal identity.');
  }
  if(next.version!==previous.version+1){
    throw new Error('plan revision version must advance exactly by one.');
  }
  const previousById=new Map(previous.nodes.map((n)=>[n.id,n]));
  const previousStateById=new Map(previousStates.map((s)=>[s.nodeId,s]));
  const changed=next.nodes.filter((node)=>{
    const prior=previousById.get(node.id);
    return !prior||digestPlan(prior)!==digestPlan(node);
  }).map((n)=>n.id).sort();

  const reset=new Set(dependentClosure(next,changed));
  const initialized=initializeNodeStates(next,now);
  const states=initialized.map((fresh)=>{
    if(reset.has(fresh.nodeId)) return fresh;
    const prior=previousStateById.get(fresh.nodeId);
    return prior?structuredClone(prior):fresh;
  });
  const preservedSucceeded=states.filter((s)=>s.status==='SUCCEEDED'&&!reset.has(s.nodeId)).map((s)=>s.nodeId).sort();
  const preservedNodeDigests=next.nodes
    .filter((node)=>!reset.has(node.id)&&previousById.has(node.id)&&digestPlan(previousById.get(node.id))===digestPlan(node))
    .map((node)=>({nodeId:node.id,nodeDigest:digestPlan(node)}))
    .sort((a,b)=>a.nodeId.localeCompare(b.nodeId));

  const proof=createRevisionProof({
    planId:next.planId,goalId:next.goalId,fromVersion:previous.version,toVersion:next.version,
    fromPlanDigest:digestPlan(previous),toPlanDigest:digestPlan(next),preservedNodeDigests,
    resetNodeIds:[...reset].sort(),createdAt:now
  });
  return {
    graph:next,states,changedNodeIds:changed,resetNodeIds:[...reset].sort(),
    preservedSucceededNodeIds:preservedSucceeded,proof
  };
}

export function validateRevisionProof(input:PlanRevisionProof):PlanRevisionProof{
  if(!input||typeof input!=='object') throw new Error('plan revision proof is required.');
  const body=normalizeProofBody(input);
  const expected=crypto.createHash('sha256').update(canonical(body)).digest('hex');
  const actual=sha256(input.digest,'revision.digest');
  if(actual!==expected) throw new Error('plan revision proof digest does not match content.');
  return {digest:actual,...body};
}

function createRevisionProof(input:Omit<PlanRevisionProof,'digest'>):PlanRevisionProof{
  const body=normalizeProofBody(input);
  const digest=crypto.createHash('sha256').update(canonical(body)).digest('hex');
  return {digest,...body};
}

function normalizeProofBody(input:Omit<PlanRevisionProof,'digest'>|PlanRevisionProof){
  const fromVersion=integer(input.fromVersion,1,Number.MAX_SAFE_INTEGER,'revision.fromVersion');
  const toVersion=integer(input.toVersion,2,Number.MAX_SAFE_INTEGER,'revision.toVersion');
  if(toVersion!==fromVersion+1) throw new Error('revision proof versions must be consecutive.');
  const preserved=input.preservedNodeDigests.map((entry)=>({
    nodeId:bounded(entry.nodeId,256,'revision.nodeId'),
    nodeDigest:sha256(entry.nodeDigest,'revision.nodeDigest')
  })).sort((a,b)=>a.nodeId.localeCompare(b.nodeId));
  if(new Set(preserved.map((entry)=>entry.nodeId)).size!==preserved.length){
    throw new Error('revision preserved node ids must be unique.');
  }
  return {
    planId:bounded(input.planId,256,'revision.planId'),
    goalId:bounded(input.goalId,256,'revision.goalId'),
    fromVersion,toVersion,
    fromPlanDigest:sha256(input.fromPlanDigest,'revision.fromPlanDigest'),
    toPlanDigest:sha256(input.toPlanDigest,'revision.toPlanDigest'),
    preservedNodeDigests:preserved,
    resetNodeIds:[...new Set(input.resetNodeIds.map((id)=>bounded(id,256,'revision.resetNodeId')))].sort(),
    createdAt:validIso(input.createdAt,'revision.createdAt')
  };
}

function bounded(v:unknown,m:number,l:string):string{if(typeof v!=='string'||!v||v.length>m)throw new Error(l+' is invalid.');return v;}
function integer(v:unknown,min:number,max:number,l:string):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)throw new Error(l+' is invalid.');return v;}
function sha256(v:unknown,l:string):string{if(typeof v!=='string'||!/^[0-9a-fA-F]{64}$/.test(v))throw new Error(l+' must be SHA-256.');return v.toLowerCase();}
function validIso(v:unknown,l:string):string{if(typeof v!=='string')throw new Error(l+' is invalid.');const p=Date.parse(v);if(!Number.isFinite(p)||new Date(p).toISOString()!==v)throw new Error(l+' must be ISO timestamp.');return v;}
