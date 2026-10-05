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
  searchExhausted?:boolean;
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
  const searchExhausted=input.searchExhausted===true;

  const missingCapabilityNodes=actionable.filter((n)=>n.allowedCapabilities.length>0&&!n.allowedCapabilities.some((c)=>available.has(c)));
  if(actionable.length>0&&missingCapabilityNodes.length===actionable.length){
    evidence.push(...missingCapabilityNodes.map((n)=>'missing-capability-node:'+n.id));
    if(searchExhausted) return result('CAPABILITY_MISSING',0.98,true,evidence,'Every searched executable path requires unavailable capabilities.');
    return result('INSUFFICIENT_EVIDENCE',0.55,false,evidence,'Current paths need unavailable capabilities, but alternative-plan search is not exhausted.');
  }

  const denied=new Set(input.authorityDeniedNodeIds??[]);
  const remainingActionNodes=actionable.filter((n)=>!['SUCCEEDED','SKIPPED'].includes(input.states.find((s)=>s.nodeId===n.id)?.status??'PENDING'));
  if(remainingActionNodes.length>0&&remainingActionNodes.every((n)=>denied.has(n.id))){
    evidence.push(...remainingActionNodes.map((n)=>'authority-denied-node:'+n.id));
    if(searchExhausted) return result('AUTHORITY_DENIED',1,true,evidence,'Authority denies every searched executable path.');
    return result('INSUFFICIENT_EVIDENCE',0.6,false,evidence,'Known paths are authority-denied, but alternative-plan search is not exhausted.');
  }

  const unobservable=[...new Set(input.requiredUnobservableFacts??[])];
  const requiredFacts=new Set(unfinished.flatMap((n)=>n.preconditions.map((p)=>p.factKey)));
  const blockingUnobservable=unobservable.filter((f)=>requiredFacts.has(f));
  if(blockingUnobservable.length){
    evidence.push(...blockingUnobservable.map((f)=>'unobservable:'+f));
    if(searchExhausted) return result('REQUIRED_STATE_UNOBSERVABLE',0.95,true,evidence,'Required state cannot be observed on any searched path.');
    return result('INSUFFICIENT_EVIDENCE',0.55,false,evidence,'Known paths require unobservable state, but alternative-plan search is not exhausted.');
  }

  if(input.remainingCostBudget!==undefined){
    if(!Number.isFinite(input.remainingCostBudget)||input.remainingCostBudget<0) throw new Error('remainingCostBudget is invalid.');
    const cheapest=actionable.length?Math.min(...actionable.map((n)=>n.expectedCost)):0;
    if(actionable.length&&cheapest>input.remainingCostBudget){
      evidence.push('remaining-budget:'+input.remainingCostBudget,'cheapest-action:'+cheapest);
      if(searchExhausted) return result('BUDGET_EXHAUSTED',1,true,evidence,'No searched executable path fits the hard cost budget.');
      return result('INSUFFICIENT_EVIDENCE',0.55,false,evidence,'Known paths exceed budget, but alternative-plan search is not exhausted.');
    }
  }

  const failedDependencies=input.states.filter((s)=>s.status==='FAILED'||s.status==='INVALIDATED');
  const nonTerminalRoots=input.graph.rootNodeIds.filter((id)=>{
    const state=input.states.find((s)=>s.nodeId===id);
    return !state||!['FAILED','INVALIDATED'].includes(state.status);
  });
  if(failedDependencies.length&&nonTerminalRoots.length===0){
    evidence.push(...failedDependencies.map((s)=>'failed-dependency:'+s.nodeId));
    if(searchExhausted) return result('DEPENDENCY_IMPOSSIBLE',0.95,true,evidence,'All searched root plan paths are invalidated by failed dependencies.');
    return result('INSUFFICIENT_EVIDENCE',0.55,false,evidence,'Current root paths failed, but replanning search is not exhausted.');
  }

  if(unfinished.length===0) return result('NONE',1,false,[],'Plan has no unresolved work.');
  return result('INSUFFICIENT_EVIDENCE',0.35,false,[],'The plan is unresolved, but there is not enough evidence to declare it impossible.');
}

function result(
  cls:InfeasibilityAssessment['class'],confidence:number,terminal:boolean,evidence:string[],reason:string
):InfeasibilityAssessment{
  return {class:cls,confidence,terminal,evidence:[...new Set(evidence)].sort(),reason};
}
