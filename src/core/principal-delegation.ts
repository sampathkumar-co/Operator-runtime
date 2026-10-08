import { OperatorError } from './errors.ts';
import type { ActionRisk } from './types.ts';

export type PrincipalKind = 'human' | 'service' | 'agent' | 'subagent' | 'workflow' | 'device' | 'organization' | 'project' | 'environment';
export interface Principal { id:string; kind:PrincipalKind; enabled:boolean; }
export interface AuthorityGrant {
  capabilities:string[];
  resourcePrefixes:string[];
  maxRisk:ActionRisk;
  expiresAt?:string;
}
export interface Delegation {
  id:string;
  parentPrincipalId:string;
  childPrincipalId:string;
  purpose:string;
  grant:AuthorityGrant;
  createdAt:string;
}
export interface PrincipalDelegationGraph {
  schemaVersion:1;
  principals:Principal[];
  delegations:Delegation[];
}

const RISK:Record<ActionRisk,number>={read:0,write:1,external:2,system:3,destructive:4};

export function validatePrincipalDelegationGraph(
  input: PrincipalDelegationGraph,
  rootAuthority: Readonly<Record<string, AuthorityGrant>>
): PrincipalDelegationGraph {
  if(!input||input.schemaVersion!==1||!Array.isArray(input.principals)||!Array.isArray(input.delegations)) throw invalid('Delegation graph shape is invalid.');
  if(input.principals.length>100_000||input.delegations.length>500_000) throw invalid('Delegation graph exceeds bounded size.');
  const principals=input.principals.map(normalizePrincipal);
  const byId=new Map(principals.map(p=>[p.id,p]));
  if(byId.size!==principals.length) throw invalid('Principal IDs must be unique.');
  const delegations=input.delegations.map(normalizeDelegation);
  if(new Set(delegations.map(d=>d.id)).size!==delegations.length) throw invalid('Delegation IDs must be unique.');
  for(const d of delegations){
    if(!byId.has(d.parentPrincipalId)||!byId.has(d.childPrincipalId)) throw invalid('Delegation references an unknown principal.');
    if(d.parentPrincipalId===d.childPrincipalId) throw invalid('Self-delegation is not permitted.');
  }
  assertAcyclic(delegations);

  const incoming=new Map<string,Delegation[]>();
  for(const d of delegations){ const rows=incoming.get(d.childPrincipalId)??[]; rows.push(d); incoming.set(d.childPrincipalId,rows); }
  for(const principal of principals){
    const roots=rootAuthority[principal.id];
    if(roots) validateAuthorityGrant(roots);
    const parents=incoming.get(principal.id)??[];
    if(!roots && parents.length===0) throw invalid(`Principal ${principal.id} has no authority source.`);
    for(const d of parents){
      const parentSources=effectiveGrantSources(d.parentPrincipalId,delegations,rootAuthority,new Set());
      assertAttenuatesAny(parentSources,d.grant,d.id);
    }
  }
  return {schemaVersion:1,principals,delegations};
}

export function assertAttenuates(parentInput:AuthorityGrant,childInput:AuthorityGrant,label='delegation'):void{
  const parent=validateAuthorityGrant(parentInput), child=validateAuthorityGrant(childInput);
  if(RISK[child.maxRisk]>RISK[parent.maxRisk]) throw invalid(`${label} expands risk authority.`);
  for(const cap of child.capabilities){
    if(!parent.capabilities.some(rule=>matchesCapability(cap,rule))) throw invalid(`${label} expands capability authority.`);
  }
  for(const resource of child.resourcePrefixes){
    if(parent.resourcePrefixes.length>0&&!parent.resourcePrefixes.some(prefix=>withinPrefix(resource,prefix))) throw invalid(`${label} expands resource authority.`);
  }
  if(parent.expiresAt){
    if(!child.expiresAt||Date.parse(child.expiresAt)>Date.parse(parent.expiresAt)) throw invalid(`${label} expands authority lifetime.`);
  }
}

export function effectiveGrant(
  principalId:string,
  delegations:Delegation[],
  rootAuthority:Readonly<Record<string,AuthorityGrant>>,
  visiting=new Set<string>()
):AuthorityGrant{
  return mergeUnion(effectiveGrantSources(principalId,delegations,rootAuthority,visiting));
}

function effectiveGrantSources(
  principalId:string,
  delegations:Delegation[],
  rootAuthority:Readonly<Record<string,AuthorityGrant>>,
  visiting:Set<string>
):AuthorityGrant[]{
  if(visiting.has(principalId)) throw invalid('Delegation graph contains a cycle.');
  const nextVisiting=new Set(visiting); nextVisiting.add(principalId);
  const root=rootAuthority[principalId];
  const incoming=delegations.filter(d=>d.childPrincipalId===principalId);
  const sources:AuthorityGrant[]=[];
  if(root) sources.push(validateAuthorityGrant(root));
  for(const d of incoming){
    const parentSources=effectiveGrantSources(d.parentPrincipalId,delegations,rootAuthority,nextVisiting);
    assertAttenuatesAny(parentSources,d.grant,d.id);
    sources.push(validateAuthorityGrant(d.grant));
  }
  if(sources.length===0) throw invalid(`Principal ${principalId} has no authority source.`);
  return sources;
}

function assertAttenuatesAny(parents:AuthorityGrant[],child:AuthorityGrant,label:string):void{
  for(const parent of parents){
    try{assertAttenuates(parent,child,label);return;}catch{}
  }
  throw invalid(`${label} expands authority beyond every complete parent grant.`);
}

function mergeUnion(grants:AuthorityGrant[]):AuthorityGrant{
  const normalized=grants.map(validateAuthorityGrant);
  const capabilities=[...new Set(normalized.flatMap(g=>g.capabilities))].sort();
  const unrestrictedResources=normalized.some(g=>g.resourcePrefixes.length===0);
  const resourcePrefixes=unrestrictedResources?[]:[...new Set(normalized.flatMap(g=>g.resourcePrefixes))].sort();
  // A flat summary cannot safely assign the highest source risk to capabilities
  // from lower-risk sources, so use the minimum risk. This may understate the
  // union but can never widen it.
  const maxRisk=normalized.reduce<ActionRisk>((least,g)=>RISK[g.maxRisk]<RISK[least]?g.maxRisk:least,'destructive');
  const expiries=normalized.map(g=>g.expiresAt).filter((v):v is string=>Boolean(v));
  const summary={capabilities,resourcePrefixes,maxRisk,...(expiries.length?{expiresAt:expiries.sort().at(0)!}:{})};

  const resourcesForCheck=resourcePrefixes.length===0?[undefined]:resourcePrefixes;
  for(const capability of capabilities){
    for(const resource of resourcesForCheck){
      const covered=normalized.some(source=>
        RISK[source.maxRisk]>=RISK[maxRisk]
        && source.capabilities.some(rule=>matchesCapability(capability,rule))
        && (resource===undefined
          ? source.resourcePrefixes.length===0
          : source.resourcePrefixes.length===0||source.resourcePrefixes.some(prefix=>withinPrefix(resource,prefix)))
      );
      if(!covered) throw invalid('Effective authority sources cannot be flattened without creating cross-product authority.');
    }
  }
  return summary;
}
function normalizePrincipal(p:Principal):Principal{
  if(!p||!['human','service','agent','subagent','workflow','device','organization','project','environment'].includes(p.kind)||typeof p.enabled!=='boolean') throw invalid('Principal is invalid.');
  return {id:id(p.id,'principal id'),kind:p.kind,enabled:p.enabled};
}
function normalizeDelegation(d:Delegation):Delegation{
  if(!d) throw invalid('Delegation is invalid.');
  return {id:id(d.id,'delegation id'),parentPrincipalId:id(d.parentPrincipalId,'parent principal'),childPrincipalId:id(d.childPrincipalId,'child principal'),purpose:text(d.purpose,1024,'purpose'),grant:validateAuthorityGrant(d.grant),createdAt:iso(d.createdAt,'createdAt')};
}
export function validateAuthorityGrant(g:AuthorityGrant):AuthorityGrant{
  if(!g||!Array.isArray(g.capabilities)||g.capabilities.length>512||!Array.isArray(g.resourcePrefixes)||g.resourcePrefixes.length>2048||!(g.maxRisk in RISK)) throw invalid('Authority grant is invalid.');
  const capabilities=[...new Set(g.capabilities.map((v)=>pattern(v)))].sort();
  const resourcePrefixes=[...new Set(g.resourcePrefixes.map(v=>text(v,4096,'resource prefix')))].sort();
  const expiresAt=g.expiresAt===undefined?undefined:iso(g.expiresAt,'expiresAt');
  return {capabilities,resourcePrefixes,maxRisk:g.maxRisk,...(expiresAt?{expiresAt}:{})};
}
function matchesCapability(child:string,parent:string):boolean{
  return child===parent||(parent.endsWith('.*')&&child.startsWith(parent.slice(0,-1)));
}
function withinPrefix(child:string,parent:string):boolean{return child===parent||child.startsWith(parent.endsWith('/')?parent:parent+'/')||child.startsWith(parent.endsWith(':')?parent:parent+':');}
function assertAcyclic(ds:Delegation[]):void{
  const edges=new Map<string,string[]>(); for(const d of ds){const r=edges.get(d.parentPrincipalId)??[];r.push(d.childPrincipalId);edges.set(d.parentPrincipalId,r);}
  const visiting=new Set<string>(),done=new Set<string>();
  const visit=(idv:string)=>{if(done.has(idv))return;if(visiting.has(idv))throw invalid('Delegation graph contains a cycle.');visiting.add(idv);for(const c of edges.get(idv)??[])visit(c);visiting.delete(idv);done.add(idv);};
  for(const k of edges.keys())visit(k);
}
function id(v:unknown,l:string):string{const s=String(v??'');if(!/^[A-Za-z0-9._:@-]{1,256}$/.test(s))throw invalid(`${l} is invalid.`);return s;}
function pattern(v:unknown):string{const s=text(v,256,'capability');if(!/^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\.\*)?$/.test(s))throw invalid('Capability pattern is invalid.');return s;}
function text(v:unknown,max:number,l:string):string{if(typeof v!=='string'||!v.trim()||Buffer.byteLength(v,'utf8')>max||v.includes('\0'))throw invalid(`${l} is invalid.`);return v;}
function iso(v:unknown,l:string):string{const s=String(v??'');if(!s||!Number.isFinite(Date.parse(s))||new Date(s).toISOString()!==s)throw invalid(`${l} must be canonical ISO.`);return s;}
function invalid(m:string):OperatorError{return new OperatorError('DELEGATION_GRAPH_INVALID',m);}
