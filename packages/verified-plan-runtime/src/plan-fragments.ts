import type { PlanGraph, PlanNodeState } from './contracts.ts';
import { canonical } from './lineage.ts';
import crypto from 'node:crypto';

export interface PlanFragmentStep {
  kind:'OBSERVE'|'ACTION'|'VERIFY';
  capabilities:string[];
  preconditionSlots:string[];
  effectSlots:string[];
  verificationSlots:string[];
  reversible:boolean;
}

export interface PlanFragmentCandidate {
  digest:string;
  objectiveKind:string;
  scopeClass:string;
  steps:PlanFragmentStep[];
  sourceRunIds:string[];
  verificationDigests:string[];
}

export interface ExtractFragmentInput {
  graph:PlanGraph;
  states:PlanNodeState[];
  nodeIds:string[];
  objectiveKind:string;
  scopeClass:string;
  factAliases:Record<string,string>;
  sourceRunIds:string[];
  verificationDigests:string[];
  benchmarkIdentifiers?:string[];
}

export function extractPlanFragment(input:ExtractFragmentInput):PlanFragmentCandidate{
  if((input.benchmarkIdentifiers??[]).length) throw new Error('benchmark identifiers are forbidden in reusable plan fragments.');
  const sourceRunIds=unique(input.sourceRunIds.map((v)=>bounded(v,256,'sourceRunId')));
  if(sourceRunIds.length<2) throw new Error('reusable plan fragment requires at least two independent source runs.');
  const verificationDigests=unique(input.verificationDigests.map((v)=>sha256(v,'verificationDigest')));
  if(verificationDigests.length<2) throw new Error('reusable plan fragment requires independent verification evidence.');

  const selectedIds=unique(input.nodeIds.map((v)=>bounded(v,256,'nodeId')));
  if(!selectedIds.length) throw new Error('plan fragment requires at least one node.');
  const nodeById=new Map(input.graph.nodes.map((n)=>[n.id,n]));
  const stateById=new Map(input.states.map((s)=>[s.nodeId,s]));
  const selected=selectedIds.map((id)=>{
    const node=nodeById.get(id);
    if(!node) throw new Error('fragment references unknown plan node: '+id);
    if(!['OBSERVE','ACTION','VERIFY'].includes(node.kind)) throw new Error('fragment may contain only executable/verification nodes.');
    if(stateById.get(id)?.status!=='SUCCEEDED') throw new Error('fragment may learn only from succeeded plan nodes.');
    return node;
  });

  const steps:PlanFragmentStep[]=selected.map((node)=>({
    kind:node.kind as PlanFragmentStep['kind'],
    capabilities:[...node.allowedCapabilities],
    preconditionSlots:node.preconditions.map((p)=>alias(p.factKey,input.factAliases)).sort(),
    effectSlots:node.expectedEffects.map((f)=>alias(f,input.factAliases)).sort(),
    verificationSlots:node.verificationFactKeys.map((f)=>alias(f,input.factAliases)).sort(),
    reversible:node.reversible
  }));
  const body={
    objectiveKind:bounded(input.objectiveKind,256,'objectiveKind'),
    scopeClass:bounded(input.scopeClass,256,'scopeClass'),
    steps,sourceRunIds,verificationDigests
  };
  return {digest:crypto.createHash('sha256').update(canonical(body)).digest('hex'),...body};
}

function alias(factKey:string,aliases:Record<string,string>):string{
  const mapped=aliases[factKey];
  if(!mapped) throw new Error('every learned fact must be generalized through a fact alias: '+factKey);
  if(mapped===factKey) throw new Error('fact alias must abstract the source fact rather than copy it.');
  return bounded(mapped,256,'factAlias');
}
function unique(v:string[]):string[]{return [...new Set(v)].sort();}
function bounded(v:unknown,m:number,l:string):string{if(typeof v!=='string'||!v||v.length>m)throw new Error(l+' is invalid.');return v;}
function sha256(v:unknown,l:string):string{if(typeof v!=='string'||!/^[0-9a-fA-F]{64}$/.test(v))throw new Error(l+' must be SHA-256.');return v.toLowerCase();}
