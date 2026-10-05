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
  beliefsInput: BeliefView[],
  now = new Date().toISOString()
): BeliefBindingResult {
  const beliefs=normalizeBeliefs(beliefsInput);
  const beliefByFact = new Map(beliefs.map((b) => [b.factKey, b]));
  const hardInvalidRoots:string[]=[];
  for (const node of graph.nodes) {
    const state=statesInput.find((s)=>s.nodeId===node.id);
    if (!state || ['SUCCEEDED','SKIPPED','RUNNING'].includes(state.status)) continue;
    if (state.status==='BLOCKED' && state.lastExecutionDigest) continue;
    for (const p of node.preconditions) {
      const b=beliefByFact.get(p.factKey);
      if (!b) continue;
      if (b.status==='DISPROVEN') {
        hardInvalidRoots.push(node.id); break;
      }
      if (p.expectedValueDigest && b.selectedValueDigest && b.selectedValueDigest!==p.expectedValueDigest && ['KNOWN','SUPPORTED'].includes(b.status)) {
        hardInvalidRoots.push(node.id); break;
      }
    }
  }
  const invalidated = dependentClosure(graph, unique(hardInvalidRoots));
  const states=statesInput.map((state)=>{
    const unsettledExecution=
      state.status==='RUNNING' ||
      (state.status==='BLOCKED' && Boolean(state.lastExecutionDigest));
    if (invalidated.includes(state.nodeId) && state.status!=='SUCCEEDED' && !unsettledExecution) {
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

function normalizeBeliefs(input:BeliefView[]):BeliefView[]{
  if(!Array.isArray(input)||input.length>10_000) throw new Error('belief list is invalid.');
  const statuses=new Set(['KNOWN','SUPPORTED','CONFLICTED','STALE','UNKNOWN','UNOBSERVABLE','DISPROVEN']);
  const seen=new Set<string>();
  return input.map((belief)=>{
    if(!belief||typeof belief!=='object') throw new Error('belief is invalid.');
    const factKey=bounded(belief.factKey,512,'belief.factKey');
    if(seen.has(factKey)) throw new Error('belief facts must be unique: '+factKey);
    seen.add(factKey);
    if(!statuses.has(belief.status)) throw new Error('belief.status is invalid.');
    if(typeof belief.confidence!=='number'||!Number.isFinite(belief.confidence)||belief.confidence<0||belief.confidence>1){
      throw new Error('belief.confidence is invalid.');
    }
    const evidence=belief.evidenceDigests;
    if(!Array.isArray(evidence)||evidence.length>1000) throw new Error('belief.evidenceDigests is invalid.');
    return {
      factKey,status:belief.status,confidence:belief.confidence,
      ...(belief.selectedValueDigest?{selectedValueDigest:sha256(belief.selectedValueDigest,'belief.selectedValueDigest')}:{ }),
      evidenceDigests:[...new Set(evidence.map((value)=>sha256(value,'belief.evidenceDigest')))].sort()
    };
  });
}
function unique(v:string[]):string[]{return [...new Set(v)].sort();}
function bounded(v:unknown,m:number,l:string):string{if(typeof v!=='string'||!v||v.length>m)throw new Error(l+' is invalid.');return v;}
function sha256(v:unknown,l:string):string{if(typeof v!=='string'||!/^[0-9a-fA-F]{64}$/.test(v))throw new Error(l+' must be SHA-256.');return v.toLowerCase();}
