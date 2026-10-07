import { OperatorError } from './errors.ts';
import type { ActionRisk } from './types.ts';

export interface EnterprisePolicyRule {
  id: string;
  principalPrefixes?: string[];
  capabilityPatterns?: string[];
  maxRisk?: ActionRisk;
  resourcePrefixes?: string[];
  environments?: string[];
  requiredDevicePosture?: string[];
  allowedLocations?: string[];
  sessionPrefixes?: string[];
  notBefore?: string;
  notAfter?: string;
  minApprovalQuorum?: number;
  requireSeparationOfDuties?: boolean;
  requiredEvidenceClasses?: string[];
  requireIndependentVerifier?: boolean;
  maxActionCost?: number;
  maxSessionCost?: number;
  allowedRetentionClasses?: string[];
  allowedPublication?: Array<'internal'|'restricted'|'public'>;
}

export interface EnterprisePolicyEvaluationContext {
  principalId: string;
  delegatedFrom?: string[];
  capability: string;
  risk: ActionRisk;
  resource?: string;
  environment?: string;
  devicePosture?: string[];
  location?: string;
  sessionId?: string;
  timestamp: string;
  approverPrincipalIds?: string[];
  actorPrincipalIds?: string[];
  evidenceClasses?: string[];
  independentVerifierPresent?: boolean;
  estimatedActionCost?: number;
  sessionCost?: number;
  retentionClass?: string;
  publication?: 'internal'|'restricted'|'public';
  purpose: string;
}

export interface EnterprisePolicyLanguageDecision {
  allowed: boolean;
  matchedRuleIds: string[];
  reasons: string[];
}

const RISK:Record<ActionRisk,number>={read:0,write:1,external:2,system:3,destructive:4};

export function evaluateEnterprisePolicyLanguage(
  rulesInput:EnterprisePolicyRule[],
  ctxInput:EnterprisePolicyEvaluationContext
):EnterprisePolicyLanguageDecision{
  const ctx=normalizeContext(ctxInput);
  if(!Array.isArray(rulesInput)||rulesInput.length<1||rulesInput.length>10_000) throw invalid('Policy rules are invalid.');
  const rules=rulesInput.map(normalizeRule);
  const matched=rules.filter((rule)=>matchesScope(rule,ctx));
  if(matched.length===0)return{allowed:false,matchedRuleIds:[],reasons:['No enterprise policy rule matches this principal/capability/resource/environment context.']};
  const reasons:string[]=[];
  for(const rule of matched)evaluateConstraints(rule,ctx,reasons);
  return{allowed:reasons.length===0,matchedRuleIds:matched.map((r)=>r.id).sort(),reasons:[...new Set(reasons)]};
}

export function explainEnterpriseMutation(
  ctxInput:EnterprisePolicyEvaluationContext,
  decision:EnterprisePolicyLanguageDecision
):{who:string;what:string;why:string;where:string;allowed:boolean;reasons:string[]}{
  const ctx=normalizeContext(ctxInput);
  const delegated=ctx.delegatedFrom.length ? ' delegated from '+ctx.delegatedFrom.join(' -> ') : '';
  return{
    who:ctx.principalId+delegated,
    what:ctx.capability+' ('+ctx.risk+')',
    why:ctx.purpose,
    where:[ctx.resource,ctx.environment,ctx.location,ctx.sessionId].filter(Boolean).join(' | ')||'unspecified',
    allowed:decision.allowed,
    reasons:[...decision.reasons]
  };
}

function matchesScope(rule:EnterprisePolicyRule,ctx:ReturnType<typeof normalizeContext>):boolean{
  if(rule.principalPrefixes?.length&&!rule.principalPrefixes.some((p)=>ctx.principalId.startsWith(p)))return false;
  if(rule.capabilityPatterns?.length&&!rule.capabilityPatterns.some((p)=>capabilityMatch(ctx.capability,p)))return false;
  if(rule.resourcePrefixes?.length&&(!ctx.resource||!rule.resourcePrefixes.some((p)=>ctx.resource!.startsWith(p))))return false;
  if(rule.environments?.length&&(!ctx.environment||!rule.environments.includes(ctx.environment)))return false;
  if(rule.sessionPrefixes?.length&&(!ctx.sessionId||!rule.sessionPrefixes.some((p)=>ctx.sessionId!.startsWith(p))))return false;
  return true;
}

function evaluateConstraints(rule:EnterprisePolicyRule,ctx:ReturnType<typeof normalizeContext>,reasons:string[]):void{
  if(rule.maxRisk&&RISK[ctx.risk]>RISK[rule.maxRisk])reasons.push(rule.id+': risk exceeds '+rule.maxRisk+'.');
  if(rule.requiredDevicePosture?.some((p)=>!ctx.devicePosture.includes(p)))reasons.push(rule.id+': required device posture is missing.');
  if(rule.allowedLocations?.length&&(!ctx.location||!rule.allowedLocations.includes(ctx.location)))reasons.push(rule.id+': location is not allowed.');
  const now=Date.parse(ctx.timestamp);
  if(rule.notBefore&&now<Date.parse(rule.notBefore))reasons.push(rule.id+': policy is not active yet.');
  if(rule.notAfter&&now>Date.parse(rule.notAfter))reasons.push(rule.id+': policy has expired.');
  const approvers=new Set(ctx.approverPrincipalIds);
  if(rule.minApprovalQuorum!==undefined&&approvers.size<rule.minApprovalQuorum)reasons.push(rule.id+': approval quorum is not satisfied.');
  if(rule.requireSeparationOfDuties&&ctx.actorPrincipalIds.some((p)=>approvers.has(p)))reasons.push(rule.id+': separation of duties is violated.');
  if(rule.requiredEvidenceClasses?.some((e)=>!ctx.evidenceClasses.includes(e)))reasons.push(rule.id+': required evidence class is missing.');
  if(rule.requireIndependentVerifier&&ctx.independentVerifierPresent!==true)reasons.push(rule.id+': independent verifier is required.');
  if(rule.maxActionCost!==undefined&&(ctx.estimatedActionCost??Number.POSITIVE_INFINITY)>rule.maxActionCost)reasons.push(rule.id+': action cost ceiling exceeded.');
  if(rule.maxSessionCost!==undefined&&(ctx.sessionCost??Number.POSITIVE_INFINITY)>rule.maxSessionCost)reasons.push(rule.id+': session cost ceiling exceeded.');
  if(rule.allowedRetentionClasses?.length&&(!ctx.retentionClass||!rule.allowedRetentionClasses.includes(ctx.retentionClass)))reasons.push(rule.id+': retention class is not allowed.');
  if(rule.allowedPublication?.length&&(!ctx.publication||!rule.allowedPublication.includes(ctx.publication)))reasons.push(rule.id+': publication class is not allowed.');
}

function normalizeRule(r:EnterprisePolicyRule):EnterprisePolicyRule{
  if(!r||typeof r!=='object')throw invalid('Policy rule is invalid.');
  if(r.allowedPublication&&r.allowedPublication.some((v)=>!['internal','restricted','public'].includes(v)))throw invalid('allowedPublication is invalid.');
  return{
    id:id(r.id,'rule id'),
    ...(r.principalPrefixes?{principalPrefixes:list(r.principalPrefixes,256,'principalPrefixes')}:{ }),
    ...(r.capabilityPatterns?{capabilityPatterns:list(r.capabilityPatterns,256,'capabilityPatterns')}:{ }),
    ...(r.maxRisk?{maxRisk:risk(r.maxRisk)}:{ }),
    ...(r.resourcePrefixes?{resourcePrefixes:list(r.resourcePrefixes,1024,'resourcePrefixes')}:{ }),
    ...(r.environments?{environments:list(r.environments,128,'environments')}:{ }),
    ...(r.requiredDevicePosture?{requiredDevicePosture:list(r.requiredDevicePosture,128,'requiredDevicePosture')}:{ }),
    ...(r.allowedLocations?{allowedLocations:list(r.allowedLocations,128,'allowedLocations')}:{ }),
    ...(r.sessionPrefixes?{sessionPrefixes:list(r.sessionPrefixes,128,'sessionPrefixes')}:{ }),
    ...(r.notBefore?{notBefore:iso(r.notBefore,'notBefore')}:{ }),
    ...(r.notAfter?{notAfter:iso(r.notAfter,'notAfter')}:{ }),
    ...(r.minApprovalQuorum!==undefined?{minApprovalQuorum:integer(r.minApprovalQuorum,0,32,'minApprovalQuorum')}:{ }),
    ...(r.requireSeparationOfDuties?{requireSeparationOfDuties:true}:{ }),
    ...(r.requiredEvidenceClasses?{requiredEvidenceClasses:list(r.requiredEvidenceClasses,128,'requiredEvidenceClasses')}:{ }),
    ...(r.requireIndependentVerifier?{requireIndependentVerifier:true}:{ }),
    ...(r.maxActionCost!==undefined?{maxActionCost:money(r.maxActionCost,'maxActionCost')}:{ }),
    ...(r.maxSessionCost!==undefined?{maxSessionCost:money(r.maxSessionCost,'maxSessionCost')}:{ }),
    ...(r.allowedRetentionClasses?{allowedRetentionClasses:list(r.allowedRetentionClasses,128,'allowedRetentionClasses')}:{ }),
    ...(r.allowedPublication?{allowedPublication:[...new Set(r.allowedPublication)]}:{ })
  };
}

function normalizeContext(c:EnterprisePolicyEvaluationContext){
  if(!c||typeof c!=='object')throw invalid('Policy evaluation context is invalid.');
  if(c.publication!==undefined&&!['internal','restricted','public'].includes(c.publication))throw invalid('publication is invalid.');
  return{
    principalId:id(c.principalId,'principalId'),
    delegatedFrom:list(c.delegatedFrom??[],256,'delegatedFrom'),
    capability:id(c.capability,'capability'),
    risk:risk(c.risk),
    resource:c.resource===undefined?undefined:text(c.resource,4096,'resource'),
    environment:c.environment===undefined?undefined:id(c.environment,'environment'),
    devicePosture:list(c.devicePosture??[],128,'devicePosture'),
    location:c.location===undefined?undefined:id(c.location,'location'),
    sessionId:c.sessionId===undefined?undefined:text(c.sessionId,512,'sessionId'),
    timestamp:iso(c.timestamp,'timestamp'),
    approverPrincipalIds:list(c.approverPrincipalIds??[],128,'approverPrincipalIds'),
    actorPrincipalIds:list(c.actorPrincipalIds??[c.principalId],128,'actorPrincipalIds'),
    evidenceClasses:list(c.evidenceClasses??[],128,'evidenceClasses'),
    independentVerifierPresent:c.independentVerifierPresent===true,
    estimatedActionCost:c.estimatedActionCost===undefined?undefined:money(c.estimatedActionCost,'estimatedActionCost'),
    sessionCost:c.sessionCost===undefined?undefined:money(c.sessionCost,'sessionCost'),
    retentionClass:c.retentionClass===undefined?undefined:id(c.retentionClass,'retentionClass'),
    publication:c.publication,
    purpose:text(c.purpose,2048,'purpose')
  };
}

function capabilityMatch(c:string,p:string):boolean{return c===p||(p.endsWith('.*')&&c.startsWith(p.slice(0,-1)));}
function risk(v:unknown):ActionRisk{if(!['read','write','external','system','destructive'].includes(String(v)))throw invalid('risk is invalid.');return v as ActionRisk;}
function list(v:unknown,max:number,label:string):string[]{if(!Array.isArray(v)||v.length>max)throw invalid(label+' is invalid.');return[...new Set(v.map((x)=>text(x,512,label)))].sort();}
function id(v:unknown,label:string):string{const s=String(v??'');if(!/^[A-Za-z0-9._:@/+\-=]{1,256}$/.test(s))throw invalid(label+' is invalid.');return s;}
function text(v:unknown,max:number,label:string):string{if(typeof v!=='string'||!v.trim()||Buffer.byteLength(v,'utf8')>max||v.includes('\0'))throw invalid(label+' is invalid.');return v;}
function iso(v:unknown,label:string):string{const s=String(v??'');if(!Number.isFinite(Date.parse(s))||new Date(s).toISOString()!==s)throw invalid(label+' is invalid.');return s;}
function integer(v:unknown,min:number,max:number,label:string):number{const n=Number(v);if(!Number.isSafeInteger(n)||n<min||n>max)throw invalid(label+' is invalid.');return n;}
function money(v:unknown,label:string):number{const n=Number(v);if(!Number.isFinite(n)||n<0||n>1_000_000_000)throw invalid(label+' is invalid.');return Math.round(n*1_000_000)/1_000_000;}
function invalid(m:string):OperatorError{return new OperatorError('ENTERPRISE_POLICY_LANGUAGE_INVALID',m);}
