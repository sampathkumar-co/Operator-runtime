import type { CompiledGoal, InfeasibilityAssessment, PlanGraph, PlanNodeState } from './contracts.ts';

export interface InfeasibilityInput {
  goal:CompiledGoal;
  graph:PlanGraph;
  states:PlanNodeState[];
  availableCapabilities:string[];
  authorityDeniedNodeIds?:string[];
  contradictoryConstraintIds?:string[];
  requiredUnobservableFacts?:string[];
  remainingCostBudget?:number;
}

export function assessInfeasibility(input:InfeasibilityInput):InfeasibilityAssessment{
  const evidence:string[]=[];
  const contradictory=[...new Set(input.contradictoryConstraintIds??[])];
  if(contradictory.length){
    evidence.push(...contradictory.map((id)=>'constraint:'+id));
    return result('CONSTRAINT_CONTRADICTION',1,true,evidence,'Hard goal constraints are mutually contradictory.');
  }

  const available=new Set(input.availableCapabilities);
  const unfinished=input.graph.nodes.filter((n)=>{
    const s=input.states.find((x)=>x.nodeId===n.id);
    return !s||!['SUCCEEDED','SKIPPED'].includes(s.status);
  });
  const actionable=unfinished.filter((n)=>n.kind==='ACTION'||n.kind==='OBSERVE'||n.kind==='VERIFY');
  const missingCapabilityNodes=actionable.filter((n)=>n.allowedCapabilities.length>0&&!n.allowedCapabilities.some((c)=>available.has(c)));
  if(actionable.length>0&&missingCapabilityNodes.length===actionable.length){
    evidence.push(...missingCapabilityNodes.map((n)=>'missing-capability-node:'+n.id));
    return result('CAPABILITY_MISSING',0.98,true,evidence,'Every remaining executable path requires unavailable capabilities.');
  }

  const denied=new Set(input.authorityDeniedNodeIds??[]);
  const remainingActionNodes=actionable.filter((n)=>!['SUCCEEDED','SKIPPED'].includes(input.states.find((s)=>s.nodeId===n.id)?.status??'PENDING'));
  if(remainingActionNodes.length>0&&remainingActionNodes.every((n)=>denied.has(n.id))){
    evidence.push(...remainingActionNodes.map((n)=>'authority-denied-node:'+n.id));
    return result('AUTHORITY_DENIED',1,true,evidence,'Authority denies every remaining executable path.');
  }

  const unobservable=[...new Set(input.requiredUnobservableFacts??[])];
  const requiredFacts=new Set(unfinished.flatMap((n)=>n.preconditions.map((p)=>p.factKey)));
  const blockingUnobservable=unobservable.filter((f)=>requiredFacts.has(f));
  if(blockingUnobservable.length){
    evidence.push(...blockingUnobservable.map((f)=>'unobservable:'+f));
    return result('REQUIRED_STATE_UNOBSERVABLE',0.95,true,evidence,'Required state cannot be observed with current capabilities.');
  }

  if(input.remainingCostBudget!==undefined){
    if(!Number.isFinite(input.remainingCostBudget)||input.remainingCostBudget<0) throw new Error('remainingCostBudget is invalid.');
    const cheapest=actionable.length?Math.min(...actionable.map((n)=>n.expectedCost)):0;
    if(actionable.length&&cheapest>input.remainingCostBudget){
      evidence.push('remaining-budget:'+input.remainingCostBudget,'cheapest-action:'+cheapest);
      return result('BUDGET_EXHAUSTED',1,true,evidence,'No remaining executable node fits the hard cost budget.');
    }
  }

  const failedDependencies=input.states.filter((s)=>s.status==='FAILED'||s.status==='INVALIDATED');
  const nonTerminalRoots=input.graph.rootNodeIds.filter((id)=>{
    const state=input.states.find((s)=>s.nodeId===id);
    return !state||!['FAILED','INVALIDATED'].includes(state.status);
  });
  if(failedDependencies.length&&nonTerminalRoots.length===0){
    evidence.push(...failedDependencies.map((s)=>'failed-dependency:'+s.nodeId));
    return result('DEPENDENCY_IMPOSSIBLE',0.95,true,evidence,'All root plan paths are invalidated by failed dependencies.');
  }

  if(unfinished.length===0) return result('NONE',1,false,[],'Plan has no unresolved work.');
  return result('INSUFFICIENT_EVIDENCE',0.35,false,[],'The plan is unresolved, but there is not enough evidence to declare it impossible.');
}

function result(
  cls:InfeasibilityAssessment['class'],confidence:number,terminal:boolean,evidence:string[],reason:string
):InfeasibilityAssessment{
  return {class:cls,confidence,terminal,evidence:[...new Set(evidence)].sort(),reason};
}
