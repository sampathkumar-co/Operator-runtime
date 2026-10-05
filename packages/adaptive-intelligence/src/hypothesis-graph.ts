import type { EvidenceRef, FailureClass } from './contracts.ts';

export type HypothesisScope = 'target' | 'action' | 'subgoal' | 'task' | 'environment';
export type HypothesisState = 'ACTIVE' | 'SUPPORTED' | 'DISPROVEN' | 'RESOLVED' | 'BLOCKED';

export interface HypothesisNode {
  id: string;
  scope: HypothesisScope;
  class: FailureClass | string;
  statement: string;
  confidence: number;
  state: HypothesisState;
  parentId?: string;
  dependsOn?: string[];
  evidence: EvidenceRef[];
  contradictingEvidence: EvidenceRef[];
  createdAt: string;
  updatedAt: string;
}

export class HypothesisGraph {
  #nodes = new Map<string, HypothesisNode>();
  #clock: () => Date;
  #maxNodes: number;

  constructor(options: { clock?: () => Date; maxNodes?: number } = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#maxNodes = integer(options.maxNodes ?? 5000, 1, 100000, 'maxNodes');
  }

  add(input: Omit<HypothesisNode,'createdAt'|'updatedAt'|'state'|'evidence'|'contradictingEvidence'> & {
    state?: HypothesisState;
    evidence?: EvidenceRef[];
    contradictingEvidence?: EvidenceRef[];
  }): HypothesisNode {
    if (this.#nodes.size >= this.#maxNodes) throw new Error('Hypothesis graph capacity exceeded.');
    const id=bounded(input.id,256,'hypothesis.id');
    if(this.#nodes.has(id)) throw new Error('Hypothesis id already exists.');
    if(input.parentId && !this.#nodes.has(input.parentId)) throw new Error('Hypothesis parent does not exist.');
    const dependsOn=unique(input.dependsOn??[]);
    for(const dependency of dependsOn) if(!this.#nodes.has(dependency)) throw new Error('Hypothesis dependency does not exist: '+dependency);
    if(dependsOn.includes(id)) throw new Error('Hypothesis cannot depend on itself.');
    const now=this.#clock().toISOString();
    const node:HypothesisNode={
      id,
      scope:scope(input.scope),
      class:bounded(input.class,256,'hypothesis.class'),
      statement:bounded(input.statement,4096,'hypothesis.statement'),
      confidence:unit(input.confidence,'hypothesis.confidence'),
      state:input.state??'ACTIVE',
      ...(input.parentId?{parentId:bounded(input.parentId,256,'hypothesis.parentId')}:{}),
      ...(dependsOn.length?{dependsOn}:{}),
      evidence:dedupeEvidence(input.evidence??[]),
      contradictingEvidence:dedupeEvidence(input.contradictingEvidence??[]),
      createdAt:now,
      updatedAt:now
    };
    this.#nodes.set(id,node);
    this.#assertAcyclic();
    return structuredClone(node);
  }

  updateEvidence(idInput:string,input:{
    support?:EvidenceRef[];
    contradict?:EvidenceRef[];
    confidence?:number;
    state?:HypothesisState;
  }):HypothesisNode{
    const id=bounded(idInput,256,'hypothesis.id');
    const current=this.#nodes.get(id);
    if(!current) throw new Error('Hypothesis does not exist.');
    const next:HypothesisNode={
      ...current,
      ...(input.confidence!==undefined?{confidence:unit(input.confidence,'hypothesis.confidence')}:{}),
      ...(input.state?{state:input.state}:{}),
      evidence:dedupeEvidence([...current.evidence,...(input.support??[])]),
      contradictingEvidence:dedupeEvidence([...current.contradictingEvidence,...(input.contradict??[])]),
      updatedAt:this.#clock().toISOString()
    };
    this.#nodes.set(id,next);
    return structuredClone(next);
  }

  active(scopeFilter?:HypothesisScope):HypothesisNode[]{
    return [...this.#nodes.values()]
      .filter(n=>['ACTIVE','SUPPORTED','BLOCKED'].includes(n.state))
      .filter(n=>!scopeFilter||n.scope===scopeFilter)
      .sort((a,b)=>b.confidence-a.confidence||a.id.localeCompare(b.id))
      .map(n=>structuredClone(n));
  }

  unresolvedDependencies(idInput:string):HypothesisNode[]{
    const id=bounded(idInput,256,'hypothesis.id');
    const node=this.#nodes.get(id);
    if(!node) throw new Error('Hypothesis does not exist.');
    return (node.dependsOn??[])
      .map(dep=>this.#nodes.get(dep)!)
      .filter(dep=>dep.state!=='RESOLVED'&&dep.state!=='DISPROVEN')
      .map(dep=>structuredClone(dep));
  }

  snapshot():HypothesisNode[]{
    return [...this.#nodes.values()].sort((a,b)=>a.id.localeCompare(b.id)).map(n=>structuredClone(n));
  }

  #assertAcyclic():void{
    const visiting=new Set<string>();
    const visited=new Set<string>();
    const visit=(id:string)=>{
      if(visiting.has(id)) throw new Error('Hypothesis dependency cycle detected.');
      if(visited.has(id)) return;
      visiting.add(id);
      const node=this.#nodes.get(id);
      for(const dep of node?.dependsOn??[]) visit(dep);
      visiting.delete(id);
      visited.add(id);
    };
    for(const id of this.#nodes.keys()) visit(id);
  }
}

function scope(input:unknown):HypothesisScope{
  const value=String(input);
  if(!['target','action','subgoal','task','environment'].includes(value)) throw new Error('hypothesis.scope is invalid.');
  return value as HypothesisScope;
}
function bounded(input:unknown,max:number,label:string):string{
  const value=String(input??'');
  if(!value||value.length>max) throw new Error(label+' is invalid.');
  return value;
}
function integer(input:unknown,min:number,max:number,label:string):number{
  const value=Number(input);
  if(!Number.isSafeInteger(value)||value<min||value>max) throw new Error(label+' is invalid.');
  return value;
}
function unit(input:unknown,label:string):number{
  const value=Number(input);
  if(!Number.isFinite(value)||value<0||value>1) throw new Error(label+' must be between 0 and 1.');
  return value;
}
function unique(values:string[]):string[]{return [...new Set(values.map(v=>bounded(v,256,'hypothesis.dependency')))];}
function dedupeEvidence(items:EvidenceRef[]):EvidenceRef[]{
  return [...new Map(items.map(item=>[item.digest,item])).values()].sort((a,b)=>b.observedAt.localeCompare(a.observedAt));
}
