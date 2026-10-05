import type { PlanGraph, PlanNodeState } from './contracts.ts';
import { dependentClosure } from './plan-graph.ts';

export interface ChoiceSelectionResult {
  choiceGroup:string;
  selectedNodeId:string;
  skippedNodeIds:string[];
  states:PlanNodeState[];
}

export function selectChoiceBranch(
  graph:PlanGraph,
  states:PlanNodeState[],
  choiceGroup:string,
  selectedNodeId:string,
  now=new Date().toISOString()
):ChoiceSelectionResult{
  const alternatives=graph.nodes.filter((n)=>n.choiceGroup===choiceGroup);
  if(alternatives.length<2) throw new Error('choice group must contain at least two alternatives.');
  if(!alternatives.some((n)=>n.id===selectedNodeId)) throw new Error('selected node is not in the choice group.');
  const stateById=new Map(states.map((s)=>[s.nodeId,s]));
  const selectedState=stateById.get(selectedNodeId);
  if(!selectedState) throw new Error('selected node state is missing.');
  if(['FAILED','INVALIDATED','SKIPPED'].includes(selectedState.status)) throw new Error('selected choice branch is not executable.');

  const siblings=alternatives.filter((n)=>n.id!==selectedNodeId);
  const committedSibling=siblings.find((n)=>stateById.get(n.id)?.status==='SUCCEEDED');
  if(committedSibling) throw new Error('choice group is already committed to a different successful branch.');
  if(siblings.some((n)=>stateById.get(n.id)?.status==='RUNNING')) {
    throw new Error('cannot switch choice while another alternative is running.');
  }

  const selectedClosure=new Set(dependentClosure(graph,[selectedNodeId]));
  const skipped=new Set<string>();
  for(const sibling of siblings){
    for(const id of dependentClosure(graph,[sibling.id])){
      if(!selectedClosure.has(id)) skipped.add(id);
    }
  }

  const next=states.map((state)=>{
    if(!skipped.has(state.nodeId)||state.status==='SUCCEEDED') return {...state};
    return {
      ...state,status:'SKIPPED' as const,lastReason:'alternative-choice-not-selected',lastUpdatedAt:now
    };
  });
  return {
    choiceGroup,selectedNodeId,skippedNodeIds:[...skipped].sort(),states:next
  };
}
