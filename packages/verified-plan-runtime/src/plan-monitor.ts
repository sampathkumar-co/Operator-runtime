import type { ExecutionObservation, PlanGraph, PlanNode, PlanNodeState, PlanRepairDecision } from './contracts.ts';
import { dependentClosure } from './plan-graph.ts';

export interface NodeOutcomeAssessment {
  accepted: boolean;
  requiresVerification: boolean;
  reason: string;
  missingExpectedEffects: string[];
}

export function assessNodeOutcome(node:PlanNode,observation:ExecutionObservation):NodeOutcomeAssessment{
  if(!observation.executionOk){
    return {accepted:false,requiresVerification:false,reason:'execution-provider-reported-failure',missingExpectedEffects:[...node.expectedEffects]};
  }
  if(observation.sideEffectState==='uncertain'){
    return {accepted:false,requiresVerification:false,reason:'mutation-side-effects-uncertain-reconciliation-required',missingExpectedEffects:[...node.expectedEffects]};
  }
  const observed=new Set([...observation.changedFactKeys,...observation.supportedFactKeys]);
  const contradicted=new Set(observation.contradictedFactKeys);
  const missing=node.expectedEffects.filter((fact)=>!observed.has(fact));
  const contradictedExpected=node.expectedEffects.filter((fact)=>contradicted.has(fact));
  if(contradictedExpected.length){
    return {accepted:false,requiresVerification:false,reason:'expected-effects-contradicted',missingExpectedEffects:unique([...missing,...contradictedExpected])};
  }
  if(missing.length){
    return {accepted:false,requiresVerification:false,reason:'expected-effects-not-observed',missingExpectedEffects:missing};
  }
  return {
    accepted:true,
    requiresVerification:node.verificationFactKeys.length>0,
    reason:node.verificationFactKeys.length?'effects-observed-awaiting-independent-verification':'effects-observed',
    missingExpectedEffects:[]
  };
}

export function planLocalRepair(
  graph:PlanGraph,
  states:PlanNodeState[],
  failedNodeId:string,
  reason:string
):PlanRepairDecision{
  if(!graph.nodes.some((n)=>n.id===failedNodeId)) throw new Error('failed node does not exist.');
  const closure=dependentClosure(graph,[failedNodeId]);
  const stateById=new Map(states.map((s)=>[s.nodeId,s]));
  const invalidated=closure.filter((id)=>stateById.get(id)?.status!=='SUCCEEDED').sort();
  const preserved=states.filter((s)=>s.status==='SUCCEEDED'&&!invalidated.includes(s.nodeId)).map((s)=>s.nodeId).sort();
  return {
    failedNodeId,
    invalidatedNodeIds:invalidated,
    preservedSucceededNodeIds:preserved,
    reason
  };
}
function unique(v:string[]):string[]{return [...new Set(v)].sort();}
