import type { BeliefView, CompiledGoal, PlanGraph, PlanNode, PlanNodeState } from './contracts.ts';

export function validatePlanGraph(goal: CompiledGoal, graph: PlanGraph): PlanGraph {
  if (!graph || typeof graph !== 'object') throw new Error('plan graph is required.');
  if (graph.goalId !== goal.id) throw new Error('plan is bound to a different goal.');
  if (!Number.isSafeInteger(graph.version) || graph.version < 1) throw new Error('plan.version must be a positive integer.');
  if (!Array.isArray(graph.nodes) || graph.nodes.length < 1 || graph.nodes.length > 10_000) {
    throw new Error('plan must contain 1-10000 nodes.');
  }
  const nodes = graph.nodes.map(normalizeNode);
  const byId = new Map<string, PlanNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) throw new Error('plan node ids must be unique.');
    byId.set(node.id, node);
  }
  const roots = unique(graph.rootNodeIds.map((id) => bounded(id, 256, 'rootNodeId')));
  if (!roots.length) throw new Error('plan requires at least one root node.');
  for (const root of roots) {
    const node = byId.get(root);
    if (!node) throw new Error('root node does not exist: ' + root);
    if (node.parentId) throw new Error('root node cannot have a parent: ' + root);
  }
  for (const node of nodes) {
    if (node.parentId && !byId.has(node.parentId)) throw new Error('unknown parent: ' + node.parentId);
    if (node.parentId === node.id) throw new Error('node cannot parent itself.');
    for (const dep of node.dependsOn) {
      if (!byId.has(dep)) throw new Error('unknown dependency: ' + dep);
      if (dep === node.id) throw new Error('node cannot depend on itself.');
    }
  }
  const choiceGroups=new Map<string,PlanNode[]>();
  for(const node of nodes){
    if(!node.choiceGroup) continue;
    const current=choiceGroups.get(node.choiceGroup)??[];
    current.push(node); choiceGroups.set(node.choiceGroup,current);
  }
  for(const [group,alternatives] of choiceGroups){
    if(alternatives.length<2) throw new Error('choice group must contain at least two alternatives: '+group);
    const parentKeys=new Set(alternatives.map((n)=>n.parentId??'__root__'));
    if(parentKeys.size!==1) throw new Error('choice alternatives must share the same hierarchical parent: '+group);
    const ids=new Set(alternatives.map((n)=>n.id));
    if(alternatives.some((n)=>n.dependsOn.some((dep)=>ids.has(dep)))){
      throw new Error('choice alternatives cannot depend on one another: '+group);
    }
  }
  assertAcyclic(nodes);
  return {
    planId: bounded(graph.planId, 256, 'plan.planId'),
    goalId: graph.goalId,
    version: graph.version,
    rootNodeIds: roots,
    nodes
  };
}

export function initializeNodeStates(graph: PlanGraph, now = new Date().toISOString()): PlanNodeState[] {
  return graph.nodes.map((node) => ({
    nodeId: node.id,
    status: node.dependsOn.length === 0 && node.preconditions.length === 0 ? 'READY' : 'PENDING',
    attempts: 0,
    lastUpdatedAt: now
  }));
}

export function readyNodeIds(
  graph: PlanGraph,
  states: PlanNodeState[],
  beliefs: BeliefView[]
): string[] {
  const byState = new Map(states.map((s) => [s.nodeId, s]));
  const beliefByFact = new Map(beliefs.map((b) => [b.factKey, b]));
  return graph.nodes.filter((node) => {
    const state = byState.get(node.id);
    if (!state || !['PENDING','READY','BLOCKED'].includes(state.status)) return false;
    // BLOCKED after a concrete execution that requires independent verification is a
    // verification wait, not a fresh execution opportunity. Belief refreshes must not
    // reopen the mutation and risk duplicate side effects.
    if (state.status === 'BLOCKED' && state.lastExecutionDigest && node.verificationFactKeys.length > 0) return false;
    if (!node.dependsOn.every((id) => byState.get(id)?.status === 'SUCCEEDED')) return false;
    return node.preconditions.every((p) => {
      const belief = beliefByFact.get(p.factKey);
      if (!belief) return false;
      if (belief.status === 'KNOWN' || belief.status === 'SUPPORTED') {
        if (belief.confidence < (p.minimumConfidence ?? 0.55)) return false;
        return !p.expectedValueDigest || belief.selectedValueDigest === p.expectedValueDigest;
      }
      return Boolean(p.allowStale && belief.status === 'STALE' && belief.confidence >= (p.minimumConfidence ?? 0.55));
    });
  }).map((node) => node.id).sort();
}

export function dependentClosure(graph: PlanGraph, startingNodeIds: string[]): string[] {
  const closure = new Set(startingNodeIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.nodes) {
      if (closure.has(node.id)) continue;
      if ((node.parentId && closure.has(node.parentId)) || node.dependsOn.some((d) => closure.has(d))) {
        closure.add(node.id);
        changed = true;
      }
    }
  }
  return [...closure].sort();
}

function normalizeNode(input:PlanNode):PlanNode{
  if(!input||typeof input!=='object') throw new Error('plan node is required.');
  const kinds=new Set(['GOAL','SUBGOAL','OBSERVE','ACTION','VERIFY','DECISION']);
  if(!kinds.has(input.kind)) throw new Error('plan node kind is invalid.');
  if(!Array.isArray(input.dependsOn)||!Array.isArray(input.preconditions)||!Array.isArray(input.expectedEffects)||
     !Array.isArray(input.verificationFactKeys)||!Array.isArray(input.allowedCapabilities)){
    throw new Error('plan node list fields are invalid.');
  }
  return {
    id: bounded(input.id,256,'node.id'),
    kind: input.kind,
    title: bounded(input.title,2048,'node.title'),
    ...(input.parentId?{parentId:bounded(input.parentId,256,'node.parentId')}:{ }),
    dependsOn: unique(input.dependsOn.map((v)=>bounded(v,256,'node.dependsOn'))),
    ...(input.choiceGroup?{choiceGroup:bounded(input.choiceGroup,256,'node.choiceGroup')}:{ }),
    preconditions: input.preconditions.map((p)=>({
      factKey:bounded(p.factKey,512,'precondition.factKey'),
      ...(p.expectedValueDigest?{expectedValueDigest:sha256(p.expectedValueDigest,'precondition.expectedValueDigest')}:{ }),
      ...(p.minimumConfidence!==undefined?{minimumConfidence:unit(p.minimumConfidence,'precondition.minimumConfidence')}:{ }),
      ...(p.allowStale!==undefined?{allowStale:Boolean(p.allowStale)}:{ })
    })),
    expectedEffects: unique(input.expectedEffects.map((v)=>bounded(v,512,'node.expectedEffect'))),
    verificationFactKeys: unique(input.verificationFactKeys.map((v)=>bounded(v,512,'node.verificationFactKey'))),
    allowedCapabilities: unique(input.allowedCapabilities.map((v)=>bounded(v,512,'node.allowedCapability'))),
    expectedCost: finite(input.expectedCost,0,1e12,'node.expectedCost'),
    risk: unit(input.risk,'node.risk'),
    reversible:Boolean(input.reversible),
    maxAttempts: integer(input.maxAttempts,1,100,'node.maxAttempts')
  };
}
function assertAcyclic(nodes:PlanNode[]):void{
  const byId=new Map(nodes.map((n)=>[n.id,n]));
  const visiting=new Set<string>(); const visited=new Set<string>();
  const visit=(id:string)=>{
    if(visiting.has(id)) throw new Error('plan graph contains a cycle at '+id);
    if(visited.has(id)) return;
    visiting.add(id);
    const n=byId.get(id)!;
    for(const dep of n.dependsOn) visit(dep);
    if(n.parentId) visit(n.parentId);
    visiting.delete(id); visited.add(id);
  };
  for(const n of nodes) visit(n.id);
}
function unique(v:string[]):string[]{return [...new Set(v)].sort();}
function bounded(v:unknown,max:number,l:string):string{if(typeof v!=='string'||!v||v.length>max)throw new Error(l+' is invalid.');return v;}
function sha256(v:unknown,l:string):string{if(typeof v!=='string'||!/^[0-9a-fA-F]{64}$/.test(v))throw new Error(l+' must be SHA-256.');return v.toLowerCase();}
function finite(v:unknown,min:number,max:number,l:string):number{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new Error(l+' is invalid.');return v;}
function unit(v:unknown,l:string):number{return finite(v,0,1,l);}
function integer(v:unknown,min:number,max:number,l:string):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)throw new Error(l+' is invalid.');return v;}
