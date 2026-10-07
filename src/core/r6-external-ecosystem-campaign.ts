import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';

export interface R6ExternalIntegrationEvidence {
  integrationId: string;
  externalPublisherId: string;
  externalDeveloper: boolean;
  agentEcosystem: string;
  adapter: 'typescript-sdk' | 'python-sdk' | 'openapi' | 'webhook';
  coreChangesRequired: boolean;
  conformancePassed: boolean;
  adversarialPassed: boolean;
  unsafeCapabilityDenied: boolean;
  trustSemanticsDigest: string;
  evidenceDigests: string[];
}

export interface R6PublisherLifecycleEvidence {
  externalPublisherId: string;
  capabilityId: string;
  signedPackageDigest: string;
  reproducibleBuildDigest: string;
  published: boolean;
  qualityMetricsObserved: boolean;
  revoked: boolean;
  revocationPropagated: boolean;
  postRevocationExecutionDenied: boolean;
  evidenceDigests: string[];
}

export interface R6ExternalEcosystemCampaignBody {
  schemaVersion: 1;
  sourceSha: string;
  campaignId: string;
  canonicalTrustSemanticsDigest: string;
  integrations: R6ExternalIntegrationEvidence[];
  publisherLifecycle: R6PublisherLifecycleEvidence;
}

export interface R6ExternalEcosystemCampaign {
  body: R6ExternalEcosystemCampaignBody;
  digest: string;
}

export interface R6ExternalEcosystemReport {
  schemaVersion: 1;
  sourceSha: string;
  campaignId: string;
  independentIntegrationCount: number;
  distinctAgentEcosystems: number;
  distinctAdapters: number;
  allTrustSemanticsIdentical: boolean;
  publicPublisherLifecyclePassed: boolean;
  status: 'CERTIFIED' | 'NOT_CERTIFIED';
  reasons: string[];
  campaignDigest: string;
  reportDigest: string;
}

export function createR6ExternalEcosystemCampaign(input:R6ExternalEcosystemCampaignBody):R6ExternalEcosystemCampaign{
  const body=normalizeBody(input);
  return {body,digest:hash(body)};
}

export function verifyR6ExternalEcosystemCampaign(input:R6ExternalEcosystemCampaign):boolean{
  try{return digest(input.digest,'campaign digest')===hash(normalizeBody(input.body));}catch{return false;}
}

export function certifyR6ExternalEcosystemCampaign(input:R6ExternalEcosystemCampaign):R6ExternalEcosystemReport{
  if(!verifyR6ExternalEcosystemCampaign(input))throw invalid('External ecosystem campaign digest verification failed.');
  const body=normalizeBody(input.body);
  const publishers=new Set(body.integrations.map((x)=>x.externalPublisherId));
  const ecosystems=new Set(body.integrations.map((x)=>x.agentEcosystem));
  const adapters=new Set(body.integrations.map((x)=>x.adapter));
  const reasons:string[]=[];
  const validIntegrations=body.integrations.filter((integration)=>
    integration.externalDeveloper &&
    !integration.coreChangesRequired &&
    integration.conformancePassed &&
    integration.adversarialPassed &&
    integration.unsafeCapabilityDenied &&
    integration.evidenceDigests.length>0
  );
  if(validIntegrations.length<3)reasons.push('fewer than three qualifying external integrations');
  if(publishers.size<3)reasons.push('external integrations are not independently published by three distinct publishers');
  if(ecosystems.size<3)reasons.push('fewer than three distinct external agent ecosystems were exercised');
  if(adapters.size<2)reasons.push('external campaign did not exercise at least two integration surfaces');
  const allTrustSemanticsIdentical=body.integrations.every((x)=>x.trustSemanticsDigest===body.canonicalTrustSemanticsDigest);
  if(!allTrustSemanticsIdentical)reasons.push('external integrations did not preserve canonical trust semantics');

  const publisher=body.publisherLifecycle;
  const publicPublisherLifecyclePassed=
    publisher.published &&
    publisher.qualityMetricsObserved &&
    publisher.revoked &&
    publisher.revocationPropagated &&
    publisher.postRevocationExecutionDenied &&
    publisher.evidenceDigests.length>=3;
  if(!publicPublisherLifecyclePassed)reasons.push('public third-party publisher publish/monitor/revoke lifecycle is incomplete');
  if(!publishers.has(publisher.externalPublisherId))reasons.push('publisher lifecycle does not belong to an independently tested integration publisher');

  const base={
    schemaVersion:1 as const,
    sourceSha:body.sourceSha,
    campaignId:body.campaignId,
    independentIntegrationCount:validIntegrations.length,
    distinctAgentEcosystems:ecosystems.size,
    distinctAdapters:adapters.size,
    allTrustSemanticsIdentical,
    publicPublisherLifecyclePassed,
    status:reasons.length===0?'CERTIFIED' as const:'NOT_CERTIFIED' as const,
    reasons,
    campaignDigest:input.digest
  };
  return {...base,reportDigest:hash(base)};
}

function normalizeBody(input:R6ExternalEcosystemCampaignBody):R6ExternalEcosystemCampaignBody{
  if(!input||input.schemaVersion!==1)throw invalid('Campaign schemaVersion must be 1.');
  if(!Array.isArray(input.integrations)||input.integrations.length>1000)throw invalid('Integrations are invalid.');
  const ids=new Set<string>();
  const integrations=input.integrations.map((item)=>{
    const integration=normalizeIntegration(item);
    if(ids.has(integration.integrationId))throw invalid('Integration IDs must be unique.');
    ids.add(integration.integrationId);
    return integration;
  });
  return{
    schemaVersion:1,
    sourceSha:gitSha(input.sourceSha,'sourceSha'),
    campaignId:id(input.campaignId,'campaignId'),
    canonicalTrustSemanticsDigest:digest(input.canonicalTrustSemanticsDigest,'canonicalTrustSemanticsDigest'),
    integrations,
    publisherLifecycle:normalizePublisher(input.publisherLifecycle)
  };
}

function normalizeIntegration(input:R6ExternalIntegrationEvidence):R6ExternalIntegrationEvidence{
  const adapter=String(input.adapter??'') as R6ExternalIntegrationEvidence['adapter'];
  if(!['typescript-sdk','python-sdk','openapi','webhook'].includes(adapter))throw invalid('Integration adapter is invalid.');
  return{
    integrationId:id(input.integrationId,'integrationId'),
    externalPublisherId:id(input.externalPublisherId,'externalPublisherId'),
    externalDeveloper:bool(input.externalDeveloper,'externalDeveloper'),
    agentEcosystem:id(input.agentEcosystem,'agentEcosystem'),
    adapter,
    coreChangesRequired:bool(input.coreChangesRequired,'coreChangesRequired'),
    conformancePassed:bool(input.conformancePassed,'conformancePassed'),
    adversarialPassed:bool(input.adversarialPassed,'adversarialPassed'),
    unsafeCapabilityDenied:bool(input.unsafeCapabilityDenied,'unsafeCapabilityDenied'),
    trustSemanticsDigest:digest(input.trustSemanticsDigest,'trustSemanticsDigest'),
    evidenceDigests:digestList(input.evidenceDigests,1000,'evidenceDigests')
  };
}

function normalizePublisher(input:R6PublisherLifecycleEvidence):R6PublisherLifecycleEvidence{
  if(!input||typeof input!=='object')throw invalid('Publisher lifecycle is invalid.');
  return{
    externalPublisherId:id(input.externalPublisherId,'externalPublisherId'),
    capabilityId:id(input.capabilityId,'capabilityId'),
    signedPackageDigest:digest(input.signedPackageDigest,'signedPackageDigest'),
    reproducibleBuildDigest:digest(input.reproducibleBuildDigest,'reproducibleBuildDigest'),
    published:bool(input.published,'published'),
    qualityMetricsObserved:bool(input.qualityMetricsObserved,'qualityMetricsObserved'),
    revoked:bool(input.revoked,'revoked'),
    revocationPropagated:bool(input.revocationPropagated,'revocationPropagated'),
    postRevocationExecutionDenied:bool(input.postRevocationExecutionDenied,'postRevocationExecutionDenied'),
    evidenceDigests:digestList(input.evidenceDigests,1000,'publisher.evidenceDigests')
  };
}

function bool(v:unknown,l:string):boolean{if(typeof v!=='boolean')throw invalid(l+' is invalid.');return v;}
function id(v:unknown,l:string):string{const s=String(v??'');if(!/^[A-Za-z0-9._:@/+-]{1,512}$/.test(s))throw invalid(l+' is invalid.');return s;}
function gitSha(v:unknown,l:string):string{const s=String(v??'').toLowerCase();if(!/^[0-9a-f]{40}$/.test(s))throw invalid(l+' must be git SHA.');return s;}
function digest(v:unknown,l:string):string{const s=String(v??'').toLowerCase();if(!/^[0-9a-f]{64}$/.test(s))throw invalid(l+' must be SHA-256.');return s;}
function digestList(v:unknown,max:number,l:string):string[]{if(!Array.isArray(v)||v.length>max)throw invalid(l+' is invalid.');return[...new Set(v.map((x)=>digest(x,l)))].sort();}
function hash(v:unknown):string{return crypto.createHash('sha256').update(canonicalJson(v),'utf8').digest('hex');}
function invalid(message:string):OperatorError{return new OperatorError('R6_EXTERNAL_ECOSYSTEM_INVALID',message);}
