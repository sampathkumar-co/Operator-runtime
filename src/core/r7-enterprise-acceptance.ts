import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';

export interface R7EnterpriseAcceptanceBody {
  schemaVersion: 1;
  sourceSha: string;
  campaignId: string;
  organizationId: string;
  operatorPrincipalId: string;
  independentVerifierId: string;
  externalIdentityProvider: boolean;
  scimProvisioned: boolean;
  scimRoleMapped: boolean;
  scimDeactivationVerified: boolean;
  authorityLeaseLifecyclePassed: boolean;
  approvalQuorumPassed: boolean;
  separationOfDutiesPassed: boolean;
  devicePostureEnforced: boolean;
  budgetQuotaEnforced: boolean;
  mutationCount: number;
  mutationExplanationCoverageRate: number;
  policyReplayActionCount: number;
  policyReplayCompleted: boolean;
  privateDeployment: {
    mode: 'private-vpc' | 'on-prem';
    publicIngressDenied: boolean;
    controlPlanePrivate: boolean;
    independentProbePassed: boolean;
    evidenceDigests: string[];
  };
  audit: {
    exportDigest: string;
    independentlyVerified: boolean;
    legalHoldVerified: boolean;
    regionalControlsVerified: boolean;
    chargebackVerified: boolean;
    evidenceDigests: string[];
  };
  evidenceDigests: string[];
}

export interface R7EnterpriseAcceptanceCampaign {
  body: R7EnterpriseAcceptanceBody;
  digest: string;
}

export interface R7EnterpriseAcceptanceReport {
  schemaVersion: 1;
  sourceSha: string;
  campaignId: string;
  status: 'CERTIFIED' | 'NOT_CERTIFIED';
  reasons: string[];
  mutationExplanationCoverageRate: number;
  policyReplayActionCount: number;
  privateDeploymentPassed: boolean;
  auditAcceptancePassed: boolean;
  campaignDigest: string;
  reportDigest: string;
}

export function createR7EnterpriseAcceptanceCampaign(input:R7EnterpriseAcceptanceBody):R7EnterpriseAcceptanceCampaign{
  const body=normalize(input);
  return {body,digest:hash(body)};
}
export function verifyR7EnterpriseAcceptanceCampaign(input:R7EnterpriseAcceptanceCampaign):boolean{
  try{return digest(input.digest,'campaign digest')===hash(normalize(input.body));}catch{return false;}
}
export function certifyR7EnterpriseAcceptanceCampaign(input:R7EnterpriseAcceptanceCampaign):R7EnterpriseAcceptanceReport{
  if(!verifyR7EnterpriseAcceptanceCampaign(input))throw invalid('Enterprise acceptance campaign digest verification failed.');
  const b=normalize(input.body),reasons:string[]=[];
  if(b.operatorPrincipalId===b.independentVerifierId)reasons.push('independent verifier must be distinct from enterprise operator');
  if(!b.externalIdentityProvider||!b.scimProvisioned||!b.scimRoleMapped||!b.scimDeactivationVerified)reasons.push('external SSO/SCIM lifecycle is incomplete');
  if(!b.authorityLeaseLifecyclePassed)reasons.push('JIT authority lease lifecycle was not proven');
  if(!b.approvalQuorumPassed)reasons.push('approval quorum was not proven');
  if(!b.separationOfDutiesPassed)reasons.push('separation of duties was not proven');
  if(!b.devicePostureEnforced)reasons.push('device posture enforcement was not proven');
  if(!b.budgetQuotaEnforced)reasons.push('budget/quota enforcement was not proven');
  if(b.mutationCount<100)reasons.push('fewer than 100 governed mutations were exercised');
  if(b.mutationExplanationCoverageRate!==1)reasons.push('who/what/why/where explanation coverage was below 100%');
  if(!b.policyReplayCompleted||b.policyReplayActionCount<100)reasons.push('policy simulation did not cover at least 100 historical actions');
  const privateDeploymentPassed=b.privateDeployment.publicIngressDenied&&b.privateDeployment.controlPlanePrivate&&b.privateDeployment.independentProbePassed&&b.privateDeployment.evidenceDigests.length>=2;
  if(!privateDeploymentPassed)reasons.push('private VPC/on-prem deployment was not independently proven');
  const auditAcceptancePassed=b.audit.independentlyVerified&&b.audit.legalHoldVerified&&b.audit.regionalControlsVerified&&b.audit.chargebackVerified&&b.audit.evidenceDigests.length>=2;
  if(!auditAcceptancePassed)reasons.push('audit export/legal hold/regional/chargeback acceptance is incomplete');
  if(b.evidenceDigests.length<3)reasons.push('insufficient independent enterprise evidence artifacts');
  const base={schemaVersion:1 as const,sourceSha:b.sourceSha,campaignId:b.campaignId,status:reasons.length===0?'CERTIFIED' as const:'NOT_CERTIFIED' as const,reasons,mutationExplanationCoverageRate:b.mutationExplanationCoverageRate,policyReplayActionCount:b.policyReplayActionCount,privateDeploymentPassed,auditAcceptancePassed,campaignDigest:input.digest};
  return {...base,reportDigest:hash(base)};
}

function normalize(input:R7EnterpriseAcceptanceBody):R7EnterpriseAcceptanceBody{
  if(!input||input.schemaVersion!==1)throw invalid('Campaign schemaVersion must be 1.');
  const mode=input.privateDeployment?.mode;
  if(!['private-vpc','on-prem'].includes(mode))throw invalid('Private deployment mode is invalid.');
  return{
    schemaVersion:1,sourceSha:gitSha(input.sourceSha,'sourceSha'),campaignId:id(input.campaignId,'campaignId'),
    organizationId:id(input.organizationId,'organizationId'),operatorPrincipalId:id(input.operatorPrincipalId,'operatorPrincipalId'),independentVerifierId:id(input.independentVerifierId,'independentVerifierId'),
    externalIdentityProvider:bool(input.externalIdentityProvider,'externalIdentityProvider'),scimProvisioned:bool(input.scimProvisioned,'scimProvisioned'),scimRoleMapped:bool(input.scimRoleMapped,'scimRoleMapped'),scimDeactivationVerified:bool(input.scimDeactivationVerified,'scimDeactivationVerified'),
    authorityLeaseLifecyclePassed:bool(input.authorityLeaseLifecyclePassed,'authorityLeaseLifecyclePassed'),approvalQuorumPassed:bool(input.approvalQuorumPassed,'approvalQuorumPassed'),separationOfDutiesPassed:bool(input.separationOfDutiesPassed,'separationOfDutiesPassed'),
    devicePostureEnforced:bool(input.devicePostureEnforced,'devicePostureEnforced'),budgetQuotaEnforced:bool(input.budgetQuotaEnforced,'budgetQuotaEnforced'),
    mutationCount:integer(input.mutationCount,0,10_000_000,'mutationCount'),mutationExplanationCoverageRate:probability(input.mutationExplanationCoverageRate,'mutationExplanationCoverageRate'),policyReplayActionCount:integer(input.policyReplayActionCount,0,10_000_000,'policyReplayActionCount'),policyReplayCompleted:bool(input.policyReplayCompleted,'policyReplayCompleted'),
    privateDeployment:{mode:mode as 'private-vpc'|'on-prem',publicIngressDenied:bool(input.privateDeployment.publicIngressDenied,'publicIngressDenied'),controlPlanePrivate:bool(input.privateDeployment.controlPlanePrivate,'controlPlanePrivate'),independentProbePassed:bool(input.privateDeployment.independentProbePassed,'independentProbePassed'),evidenceDigests:digestList(input.privateDeployment.evidenceDigests,1000,'privateDeployment.evidenceDigests')},
    audit:{exportDigest:digest(input.audit?.exportDigest,'audit.exportDigest'),independentlyVerified:bool(input.audit?.independentlyVerified,'audit.independentlyVerified'),legalHoldVerified:bool(input.audit?.legalHoldVerified,'audit.legalHoldVerified'),regionalControlsVerified:bool(input.audit?.regionalControlsVerified,'audit.regionalControlsVerified'),chargebackVerified:bool(input.audit?.chargebackVerified,'audit.chargebackVerified'),evidenceDigests:digestList(input.audit?.evidenceDigests,1000,'audit.evidenceDigests')},
    evidenceDigests:digestList(input.evidenceDigests,10_000,'evidenceDigests')
  };
}
function bool(v:unknown,l:string):boolean{if(typeof v!=='boolean')throw invalid(l+' is invalid.');return v;}
function integer(v:unknown,min:number,max:number,l:string):number{const n=Number(v);if(!Number.isSafeInteger(n)||n<min||n>max)throw invalid(l+' is invalid.');return n;}
function probability(v:unknown,l:string):number{const n=Number(v);if(!Number.isFinite(n)||n<0||n>1)throw invalid(l+' is invalid.');return n;}
function id(v:unknown,l:string):string{const s=String(v??'');if(!/^[A-Za-z0-9._:@/+-]{1,512}$/.test(s))throw invalid(l+' is invalid.');return s;}
function gitSha(v:unknown,l:string):string{const s=String(v??'').toLowerCase();if(!/^[0-9a-f]{40}$/.test(s))throw invalid(l+' must be git SHA.');return s;}
function digest(v:unknown,l:string):string{const s=String(v??'').toLowerCase();if(!/^[0-9a-f]{64}$/.test(s))throw invalid(l+' must be SHA-256.');return s;}
function digestList(v:unknown,max:number,l:string):string[]{if(!Array.isArray(v)||v.length>max)throw invalid(l+' is invalid.');return[...new Set(v.map((x)=>digest(x,l)))].sort();}
function hash(v:unknown):string{return crypto.createHash('sha256').update(canonicalJson(v),'utf8').digest('hex');}
function invalid(m:string):OperatorError{return new OperatorError('R7_ENTERPRISE_ACCEPTANCE_INVALID',m);}
