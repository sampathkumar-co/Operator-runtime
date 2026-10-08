import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';
import { verifyIndependentCampaignEvidence, type IndependentCampaignEvidence } from './independent-campaign-evidence.ts';

export interface R8TwinCaseEvidence {
  caseId: string;
  mutationClass: string;
  executorId: string;
  verifierId: string;
  verifierExternalToExecutor: boolean;
  requiredDimensions: string[];
  modeledDimensions: string[];
  absentDimensions: string[];
  fidelityDeclaredBeforeExecution: boolean;
  insufficientFidelityDenied: boolean;
  alternativePlansCompared: number;
  selectedPlanDigest: string;
  proofBundleDigest: string;
  proofVerifiedExternally: boolean;
  artifactHashesVerifiedExternally: boolean;
  signatureVerifiedExternally: boolean;
  tamperAttemptRejected: boolean;
  inferencePromotionAttempted: boolean;
  inferencePromotionRejected: boolean;
  mutationExecuted: boolean;
  postconditionVerified: boolean;
  residualUncertaintyCount: number;
  evidenceDigests: string[];
}

export interface R8IndependentProofCampaignBody {
  schemaVersion: 1;
  sourceSha: string;
  campaignId: string;
  independentVerifierImplementation: boolean;
  verifierProcessSeparated: boolean;
  executorAndVerifierCodepathsSeparated: boolean;
  cases: R8TwinCaseEvidence[];
  externalEvidenceDigests: string[];
}

export interface R8IndependentProofCampaign {
  body: R8IndependentProofCampaignBody;
  digest: string;
}

export interface R8IndependentProofReport {
  schemaVersion: 1;
  sourceSha: string;
  campaignId: string;
  caseCount: number;
  mutationClassCount: number;
  independentVerificationRate: number;
  explicitFidelityRate: number;
  externalProofVerificationRate: number;
  tamperRejectionRate: number;
  inferencePromotionRejectionRate: number;
  insufficientFidelityDenialCount: number;
  verifiedMutationRate: number;
  status: 'CERTIFIED' | 'NOT_CERTIFIED';
  reasons: string[];
  campaignDigest: string;
  reportDigest: string;
}

export function createR8IndependentProofCampaign(input:R8IndependentProofCampaignBody):R8IndependentProofCampaign{
  const body=normalize(input);
  return {body,digest:hash(body)};
}

export function verifyR8IndependentProofCampaign(input:R8IndependentProofCampaign):boolean{
  try{return digest(input.digest,'campaign digest')===hash(normalize(input.body));}catch{return false;}
}

export function certifyR8IndependentProofCampaign(input:R8IndependentProofCampaign, evidence?:IndependentCampaignEvidence):R8IndependentProofReport{
  if(!verifyR8IndependentProofCampaign(input))throw invalid('Independent proof campaign digest verification failed.');
  const b=normalize(input.body),reasons:string[]=[];
  const count=b.cases.length;
  const classes=new Set(b.cases.map((item)=>item.mutationClass));
  const independent=b.cases.filter((item)=>item.verifierExternalToExecutor&&item.executorId!==item.verifierId).length;
  const fidelity=b.cases.filter((item)=>item.fidelityDeclaredBeforeExecution).length;
  const proofVerified=b.cases.filter((item)=>item.proofVerifiedExternally&&item.artifactHashesVerifiedExternally&&item.signatureVerifiedExternally).length;
  const tamper=b.cases.filter((item)=>item.tamperAttemptRejected).length;
  const inferenceCases=b.cases.filter((item)=>item.inferencePromotionAttempted);
  const inferenceRejected=inferenceCases.filter((item)=>item.inferencePromotionRejected).length;
  const insufficientDenials=b.cases.filter((item)=>item.insufficientFidelityDenied).length;
  const verifiedMutations=b.cases.filter((item)=>item.mutationExecuted&&item.postconditionVerified&&item.residualUncertaintyCount===0).length;
  const independentVerificationRate=rate(independent,count);
  const explicitFidelityRate=rate(fidelity,count);
  const externalProofVerificationRate=rate(proofVerified,count);
  const tamperRejectionRate=rate(tamper,count);
  const inferencePromotionRejectionRate=rate(inferenceRejected,inferenceCases.length);
  const verifiedMutationRate=rate(verifiedMutations,b.cases.filter((item)=>item.mutationExecuted).length);

  if(!b.independentVerifierImplementation)reasons.push('verifier implementation was not independently implemented');
  if(!b.verifierProcessSeparated)reasons.push('verifier did not run outside the executing process');
  if(!b.executorAndVerifierCodepathsSeparated)reasons.push('executor and verifier codepaths were not separated');
  if(count<50)reasons.push('fewer than 50 representative twin/proof cases were exercised');
  if(classes.size<5)reasons.push('fewer than five mutation classes were exercised');
  if(independentVerificationRate!==1)reasons.push('not every case used an independent verifier identity');
  if(explicitFidelityRate!==1)reasons.push('twin fidelity was not declared before every case');
  if(externalProofVerificationRate!==1)reasons.push('proof/signature/artifact verification was not external for every case');
  if(tamperRejectionRate!==1)reasons.push('tampered proof was not rejected in every case');
  if(inferenceCases.length<10)reasons.push('fewer than ten inference-promotion adversarial cases were attempted');
  if(inferencePromotionRejectionRate!==1)reasons.push('an inference-promotion attempt was not rejected');
  if(insufficientDenials<10)reasons.push('fewer than ten insufficient-fidelity denial cases were proven');
  if(verifiedMutationRate!==1)reasons.push('executed mutation did not have verified zero-uncertainty postcondition coverage');
  if(b.externalEvidenceDigests.length<3)reasons.push('insufficient external verifier evidence artifacts');
  reasons.push(...verifyIndependentCampaignEvidence(
    input.digest,
    [...b.externalEvidenceDigests,...b.cases.flatMap((item)=>[item.selectedPlanDigest,item.proofBundleDigest,...item.evidenceDigests])],
    b.cases.map((item)=>item.executorId),
    b.cases.map((item)=>item.verifierId),
    evidence
  ));

  for(const item of b.cases){
    if(item.alternativePlansCompared<2)reasons.push('case '+item.caseId+' did not compare at least two plans');
    const missing=item.requiredDimensions.filter((dimension)=>!item.modeledDimensions.includes(dimension));
    if(missing.length>0&&!item.absentDimensions.some((dimension)=>missing.includes(dimension))){
      reasons.push('case '+item.caseId+' omitted required twin dimensions without explicit absence declaration');
    }
    if(item.evidenceDigests.length<1)reasons.push('case '+item.caseId+' has no external evidence artifact');
  }

  const base={
    schemaVersion:1 as const,sourceSha:b.sourceSha,campaignId:b.campaignId,caseCount:count,
    mutationClassCount:classes.size,independentVerificationRate,explicitFidelityRate,externalProofVerificationRate,
    tamperRejectionRate,inferencePromotionRejectionRate,insufficientFidelityDenialCount:insufficientDenials,
    verifiedMutationRate,status:reasons.length===0?'CERTIFIED' as const:'NOT_CERTIFIED' as const,reasons:[...new Set(reasons)],campaignDigest:input.digest
  };
  return {...base,reportDigest:hash(base)};
}

function normalize(input:R8IndependentProofCampaignBody):R8IndependentProofCampaignBody{
  if(!input||input.schemaVersion!==1)throw invalid('Campaign schemaVersion must be 1.');
  if(!Array.isArray(input.cases)||input.cases.length>10_000)throw invalid('Cases are invalid.');
  const ids=new Set<string>();
  const cases=input.cases.map((item)=>{
    const value=normalizeCase(item);
    if(ids.has(value.caseId))throw invalid('Case IDs must be unique.');
    ids.add(value.caseId);
    return value;
  });
  return{
    schemaVersion:1,sourceSha:gitSha(input.sourceSha,'sourceSha'),campaignId:id(input.campaignId,'campaignId'),
    independentVerifierImplementation:bool(input.independentVerifierImplementation,'independentVerifierImplementation'),
    verifierProcessSeparated:bool(input.verifierProcessSeparated,'verifierProcessSeparated'),
    executorAndVerifierCodepathsSeparated:bool(input.executorAndVerifierCodepathsSeparated,'executorAndVerifierCodepathsSeparated'),
    cases,externalEvidenceDigests:digestList(input.externalEvidenceDigests,10_000,'externalEvidenceDigests')
  };
}

function normalizeCase(input:R8TwinCaseEvidence):R8TwinCaseEvidence{
  return{
    caseId:id(input.caseId,'caseId'),mutationClass:id(input.mutationClass,'mutationClass'),executorId:id(input.executorId,'executorId'),verifierId:id(input.verifierId,'verifierId'),
    verifierExternalToExecutor:bool(input.verifierExternalToExecutor,'verifierExternalToExecutor'),
    requiredDimensions:idList(input.requiredDimensions,100,'requiredDimensions'),modeledDimensions:idList(input.modeledDimensions,100,'modeledDimensions'),absentDimensions:idList(input.absentDimensions,100,'absentDimensions'),
    fidelityDeclaredBeforeExecution:bool(input.fidelityDeclaredBeforeExecution,'fidelityDeclaredBeforeExecution'),
    insufficientFidelityDenied:bool(input.insufficientFidelityDenied,'insufficientFidelityDenied'),
    alternativePlansCompared:integer(input.alternativePlansCompared,0,1000,'alternativePlansCompared'),
    selectedPlanDigest:digest(input.selectedPlanDigest,'selectedPlanDigest'),proofBundleDigest:digest(input.proofBundleDigest,'proofBundleDigest'),
    proofVerifiedExternally:bool(input.proofVerifiedExternally,'proofVerifiedExternally'),artifactHashesVerifiedExternally:bool(input.artifactHashesVerifiedExternally,'artifactHashesVerifiedExternally'),signatureVerifiedExternally:bool(input.signatureVerifiedExternally,'signatureVerifiedExternally'),
    tamperAttemptRejected:bool(input.tamperAttemptRejected,'tamperAttemptRejected'),inferencePromotionAttempted:bool(input.inferencePromotionAttempted,'inferencePromotionAttempted'),inferencePromotionRejected:bool(input.inferencePromotionRejected,'inferencePromotionRejected'),
    mutationExecuted:bool(input.mutationExecuted,'mutationExecuted'),postconditionVerified:bool(input.postconditionVerified,'postconditionVerified'),residualUncertaintyCount:integer(input.residualUncertaintyCount,0,1_000_000,'residualUncertaintyCount'),
    evidenceDigests:digestList(input.evidenceDigests,1000,'evidenceDigests')
  };
}
function bool(v:unknown,l:string):boolean{if(typeof v!=='boolean')throw invalid(l+' is invalid.');return v;}
function integer(v:unknown,min:number,max:number,l:string):number{const n=Number(v);if(!Number.isSafeInteger(n)||n<min||n>max)throw invalid(l+' is invalid.');return n;}
function id(v:unknown,l:string):string{const s=String(v??'');if(!/^[A-Za-z0-9._:@/+-]{1,512}$/.test(s))throw invalid(l+' is invalid.');return s;}
function idList(v:unknown,max:number,l:string):string[]{if(!Array.isArray(v)||v.length>max)throw invalid(l+' is invalid.');return[...new Set(v.map((x)=>id(x,l)))].sort();}
function gitSha(v:unknown,l:string):string{const s=String(v??'').toLowerCase();if(!/^[0-9a-f]{40}$/.test(s))throw invalid(l+' must be git SHA.');return s;}
function digest(v:unknown,l:string):string{const s=String(v??'').toLowerCase();if(!/^[0-9a-f]{64}$/.test(s))throw invalid(l+' must be SHA-256.');return s;}
function digestList(v:unknown,max:number,l:string):string[]{if(!Array.isArray(v)||v.length>max)throw invalid(l+' is invalid.');return[...new Set(v.map((x)=>digest(x,l)))].sort();}
function rate(n:number,d:number):number{return d===0?0:Math.round((n/d)*1_000_000)/1_000_000;}
function hash(v:unknown):string{return crypto.createHash('sha256').update(canonicalJson(v),'utf8').digest('hex');}
function invalid(m:string):OperatorError{return new OperatorError('R8_INDEPENDENT_PROOF_INVALID',m);}
