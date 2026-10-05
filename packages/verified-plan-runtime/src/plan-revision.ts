import type { CompiledGoal, PlanGraph, PlanNodeState } from './contracts.ts';
import { dependentClosure, initializeNodeStates, validatePlanGraph } from './plan-graph.ts';
import { digestPlan } from './lineage.ts';

export interface PlanRevisionResult {
  graph:PlanGraph;
  states:PlanNodeState[];
  changedNodeIds:string[];
  resetNodeIds:string[];
  preservedSucceededNodeIds:string[];
}

export function revisePlan(
  goal:CompiledGoal,
  previous:PlanGraph,
  previousStates:PlanNodeState[],
  nextInput:PlanGraph,
  now=new Date().toISOString()
):PlanRevisionResult{
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
  return {
    graph:next,states,changedNodeIds:changed,resetNodeIds:[...reset].sort(),
    preservedSucceededNodeIds:preservedSucceeded
  };
}
