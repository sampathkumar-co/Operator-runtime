import type { BeliefView, PlanGraph, PlanNodeState } from './contracts.ts';
import { dependentClosure, readyNodeIds } from './plan-graph.ts';

export interface BeliefBindingResult {
  states: PlanNodeState[];
  invalidatedNodeIds: string[];
  readyNodeIds: string[];
}

export function bindPlanToBeliefs(
  graph: PlanGraph,
  statesInput: PlanNodeState[],
  beliefs: BeliefView[],
  now = new Date().toISOString()
): BeliefBindingResult {
  const beliefByFact = new Map(beliefs.map((b) => [b.factKey, b]));
  const hardInvalidRoots:string[]=[];
  for (const node of graph.nodes) {
    const state=statesInput.find((s)=>s.nodeId===node.id);
    if (!state || ['SUCCEEDED','SKIPPED'].includes(state.status)) continue;
    for (const p of node.preconditions) {
      const b=beliefByFact.get(p.factKey);
      if (!b) continue;
      if (b.status==='DISPROVEN' || b.status==='CONFLICTED') {
        hardInvalidRoots.push(node.id); break;
      }
      if (p.expectedValueDigest && b.selectedValueDigest && b.selectedValueDigest!==p.expectedValueDigest && ['KNOWN','SUPPORTED'].includes(b.status)) {
        hardInvalidRoots.push(node.id); break;
      }
    }
  }
  const invalidated = dependentClosure(graph, unique(hardInvalidRoots));
  const states=statesInput.map((state)=>{
    if (invalidated.includes(state.nodeId) && state.status!=='SUCCEEDED') {
      return {...state,status:'INVALIDATED' as const,lastReason:'belief-precondition-invalidated',lastUpdatedAt:now};
    }
    return {...state};
  });
  const ready=readyNodeIds(graph,states,beliefs);
  const readySet=new Set(ready);
  const refreshed=states.map((state)=>{
    if (readySet.has(state.nodeId) && !['SUCCEEDED','RUNNING'].includes(state.status)) {
      return {...state,status:'READY' as const,lastReason:undefined,lastUpdatedAt:now};
    }
    if (state.status==='READY' && !readySet.has(state.nodeId)) {
      return {...state,status:'BLOCKED' as const,lastReason:'preconditions-or-dependencies-not-satisfied',lastUpdatedAt:now};
    }
    return state;
  });
  return {states:refreshed,invalidatedNodeIds:invalidated,readyNodeIds:ready};
}
function unique(v:string[]):string[]{return [...new Set(v)].sort();}
