import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';
import {
  certifyVerifiableEngineeringOS,
  type EngineeringCertificationStandard,
  type EngineeringOutcomeMetrics
} from './autonomous-incident-certification.ts';

export type R10PriorRelease = 'R1'|'R2'|'R3'|'R4'|'R5'|'R6'|'R7'|'R8'|'R9';
export type R10ExecutionMode = 'direct-tool-access'|'mecord-r10';

export interface R10PriorReleaseCertification {
  release: R10PriorRelease;
  status: 'CERTIFIED';
  reportDigest: string;
  sourceSha: string;
}

export interface R10OutcomeObservation {
  mode: R10ExecutionMode;
  executorId: string;
  verifierId: string;
  independentVerifier: boolean;
  claimedComplete: boolean;
  verifiedSuccess: boolean;
  humanInterventionCount: number;
  humanInterventionMinutes: number;
  interrupted: boolean;
  recoverySucceeded: boolean;
  recoveryReceiptDigest?: string;
  authorityViolations: number;
  portableProof: boolean;
  portableProofDigest?: string;
  predictedSuccessProbability: number;
  rollbackRequired: boolean;
  rollbackSucceeded: boolean;
  rollbackReceiptDigest?: string;
  learningPolicyViolations: number;
  resultDigest: string;
  evidenceDigests: string[];
}

export interface R10PairedObjectiveEvidence {
  pairId: string;
  category: string;
  objectiveDigest: string;
  startingStateDigest: string;
  environmentDigest: string;
  rubricDigest: string;
  rubricFrozenBeforeExecution: boolean;
  startingStateReproducible: boolean;
  verifierBlindedToMode: boolean;
  executionOrder: 'baseline-first'|'r10-first';
  baseline: R10OutcomeObservation;
  current: R10OutcomeObservation;
  evidenceDigests: string[];
}

export interface R10EmpiricalOutcomeCampaignBody {
  schemaVersion: 1;
  sourceSha: string;
  campaignId: string;
  priorReleaseCertifications: R10PriorReleaseCertification[];
  pairs: R10PairedObjectiveEvidence[];
  externalEvidenceDigests: string[];
  standard?: Partial<EngineeringCertificationStandard>;
}

export interface R10EmpiricalOutcomeCampaign {
  body: R10EmpiricalOutcomeCampaignBody;
  digest: string;
}

export interface R10EmpiricalOutcomeReport {
  schemaVersion: 1;
  sourceSha: string;
  campaignId: string;
  pairCount: number;
  categoryCount: number;
  verifierCount: number;
  baselineFirstCount: number;
  r10FirstCount: number;
  interruptionCaseCount: number;
  rollbackCaseCount: number;
  baseline: EngineeringOutcomeMetrics;
  current: EngineeringOutcomeMetrics;
  meanBaselineHumanInterventionMinutes: number;
  meanCurrentHumanInterventionMinutes: number;
  engineeringCertificationDigest: string;
  status: 'CERTIFIED'|'NOT_CERTIFIED';
  reasons: string[];
  campaignDigest: string;
  reportDigest: string;
}

const REQUIRED_RELEASES:R10PriorRelease[]=['R1','R2','R3','R4','R5','R6','R7','R8','R9'];

export function createR10EmpiricalOutcomeCampaign(input:R10EmpiricalOutcomeCampaignBody):R10EmpiricalOutcomeCampaign{
  const body=normalizeCampaign(input);
  return {body,digest:hash(body)};
}

export function verifyR10EmpiricalOutcomeCampaign(input:R10EmpiricalOutcomeCampaign):boolean{
  try{return digest(input.digest,'campaign digest')===hash(normalizeCampaign(input.body));}catch{return false;}
}

export function certifyR10EmpiricalOutcomeCampaign(input:R10EmpiricalOutcomeCampaign):R10EmpiricalOutcomeReport{
  if(!verifyR10EmpiricalOutcomeCampaign(input))throw invalid('Empirical outcome campaign digest verification failed.');
  const b=normalizeCampaign(input.body);
  const reasons:string[]=[];
  const pairs=b.pairs;
  const pairCount=pairs.length;
  const categories=new Set(pairs.map((pair)=>pair.category));
  const verifierIds=new Set<string>();
  let baselineFirstCount=0,r10FirstCount=0,interruptionCaseCount=0,rollbackCaseCount=0;

  if(pairCount<30)reasons.push('fewer than 30 paired objectives were evaluated');
  if(categories.size<6)reasons.push('fewer than six representative objective categories were evaluated');

  for(const pair of pairs){
    if(!pair.rubricFrozenBeforeExecution)reasons.push('pair '+pair.pairId+' did not freeze its verification rubric before execution');
    if(!pair.startingStateReproducible)reasons.push('pair '+pair.pairId+' did not prove reproducible identical starting state');
    if(!pair.verifierBlindedToMode)reasons.push('pair '+pair.pairId+' verifier was not blinded to execution mode');
    if(pair.baseline.verifierId!==pair.current.verifierId)reasons.push('pair '+pair.pairId+' used different baseline/R10 verifiers');
    if(!pair.baseline.independentVerifier||pair.baseline.executorId===pair.baseline.verifierId)reasons.push('pair '+pair.pairId+' baseline verifier was not independent');
    if(!pair.current.independentVerifier||pair.current.executorId===pair.current.verifierId)reasons.push('pair '+pair.pairId+' R10 verifier was not independent');
    verifierIds.add(pair.current.verifierId);
    if(pair.executionOrder==='baseline-first')baselineFirstCount+=1;else r10FirstCount+=1;
    if(pair.current.interrupted)interruptionCaseCount+=1;
    if(pair.current.rollbackRequired)rollbackCaseCount+=1;
    if(pair.evidenceDigests.length<1)reasons.push('pair '+pair.pairId+' has no paired evidence artifact');
  }

  if(verifierIds.size<3)reasons.push('fewer than three independent verifier identities participated');
  if(baselineFirstCount<10||r10FirstCount<10)reasons.push('execution order was not sufficiently counterbalanced');
  if(interruptionCaseCount<10)reasons.push('fewer than ten R10 interruption/recovery cases were observed');
  if(rollbackCaseCount<10)reasons.push('fewer than ten R10 rollback-required cases were observed');
  if(b.externalEvidenceDigests.length<3)reasons.push('insufficient independent cohort evidence artifacts');

  const releaseMap=new Map(b.priorReleaseCertifications.map((item)=>[item.release,item]));
  for(const release of REQUIRED_RELEASES){
    if(!releaseMap.has(release))reasons.push('missing prior certified release evidence: '+release);
  }

  const baseline=deriveMetrics(pairs.map((pair)=>pair.baseline));
  const current=deriveMetrics(pairs.map((pair)=>pair.current));
  const baselineMinutes=mean(pairs.map((pair)=>pair.baseline.humanInterventionMinutes));
  const currentMinutes=mean(pairs.map((pair)=>pair.current.humanInterventionMinutes));

  if(current.falseCompletionRate>=baseline.falseCompletionRate)reasons.push('R10 false completion was not lower than direct tool access');
  if(current.humanInterventionRate>=baseline.humanInterventionRate)reasons.push('R10 human intervention rate was not lower than direct tool access');
  if(baselineMinutes>0&&currentMinutes/baselineMinutes>0.8)reasons.push('R10 human intervention minutes did not fall by at least 20%');
  if(baselineMinutes===0&&currentMinutes!==0)reasons.push('R10 introduced human intervention minutes where baseline required none');

  const engineering=certifyVerifiableEngineeringOS({
    baseline,
    current,
    ...(b.standard?{standard:b.standard}:{})
  });
  if(engineering.status!=='CERTIFIED')reasons.push(...engineering.reasons.map((reason)=>'engineering standard: '+reason));

  const base={
    schemaVersion:1 as const,
    sourceSha:b.sourceSha,
    campaignId:b.campaignId,
    pairCount,
    categoryCount:categories.size,
    verifierCount:verifierIds.size,
    baselineFirstCount,
    r10FirstCount,
    interruptionCaseCount,
    rollbackCaseCount,
    baseline,
    current,
    meanBaselineHumanInterventionMinutes:baselineMinutes,
    meanCurrentHumanInterventionMinutes:currentMinutes,
    engineeringCertificationDigest:engineering.certificationDigest,
    status:reasons.length===0?'CERTIFIED' as const:'NOT_CERTIFIED' as const,
    reasons:[...new Set(reasons)],
    campaignDigest:input.digest
  };
  return {...base,reportDigest:hash(base)};
}

function deriveMetrics(observations:R10OutcomeObservation[]):EngineeringOutcomeMetrics{
  const n=observations.length;
  const interrupted=observations.filter((item)=>item.interrupted);
  const rollback=observations.filter((item)=>item.rollbackRequired);
  return{
    verifiedTaskSuccessRate:rate(observations.filter((item)=>item.verifiedSuccess).length,n),
    falseCompletionRate:rate(observations.filter((item)=>item.claimedComplete&&!item.verifiedSuccess).length,n),
    humanInterventionRate:rate(observations.filter((item)=>item.humanInterventionCount>0).length,n),
    interruptionRecoveryRate:rate(interrupted.filter((item)=>item.recoverySucceeded).length,interrupted.length),
    authorityViolations:observations.reduce((sum,item)=>sum+item.authorityViolations,0),
    portableProofRate:rate(observations.filter((item)=>item.portableProof).length,n),
    uncertaintyCalibrationError:round(mean(observations.map((item)=>Math.abs(item.predictedSuccessProbability-(item.verifiedSuccess?1:0))))),
    rollbackSuccessRate:rate(rollback.filter((item)=>item.rollbackSucceeded).length,rollback.length),
    learningPolicyViolations:observations.reduce((sum,item)=>sum+item.learningPolicyViolations,0)
  };
}

function normalizeCampaign(input:R10EmpiricalOutcomeCampaignBody):R10EmpiricalOutcomeCampaignBody{
  if(!input||input.schemaVersion!==1)throw invalid('Campaign schemaVersion must be 1.');
  if(!Array.isArray(input.priorReleaseCertifications)||input.priorReleaseCertifications.length>20)throw invalid('Prior release certifications are invalid.');
  const releases=new Set<R10PriorRelease>();
  const priorReleaseCertifications=input.priorReleaseCertifications.map((item)=>{
    const value=normalizePrior(item);
    if(releases.has(value.release))throw invalid('Prior release certifications contain duplicate releases.');
    releases.add(value.release);return value;
  });
  if(!Array.isArray(input.pairs)||input.pairs.length>10_000)throw invalid('Paired objectives are invalid.');
  const ids=new Set<string>();
  const pairs=input.pairs.map((pair)=>{
    const value=normalizePair(pair);
    if(ids.has(value.pairId))throw invalid('Pair IDs must be unique.');
    ids.add(value.pairId);return value;
  });
  return{
    schemaVersion:1,
    sourceSha:gitSha(input.sourceSha,'sourceSha'),
    campaignId:id(input.campaignId,'campaignId'),
    priorReleaseCertifications,
    pairs,
    externalEvidenceDigests:digestList(input.externalEvidenceDigests,10_000,'externalEvidenceDigests'),
    ...(input.standard?{standard:normalizeStandard(input.standard)}:{})
  };
}

function normalizePrior(input:R10PriorReleaseCertification):R10PriorReleaseCertification{
  const release=String(input.release??'') as R10PriorRelease;
  if(!REQUIRED_RELEASES.includes(release))throw invalid('Prior release identifier is invalid.');
  if(input.status!=='CERTIFIED')throw invalid('Prior release evidence must be CERTIFIED.');
  return{release,status:'CERTIFIED',reportDigest:digest(input.reportDigest,'reportDigest'),sourceSha:gitSha(input.sourceSha,'prior sourceSha')};
}

function normalizePair(input:R10PairedObjectiveEvidence):R10PairedObjectiveEvidence{
  const order=String(input.executionOrder??'') as R10PairedObjectiveEvidence['executionOrder'];
  if(!['baseline-first','r10-first'].includes(order))throw invalid('Execution order is invalid.');
  const baseline=normalizeObservation(input.baseline,'direct-tool-access');
  const current=normalizeObservation(input.current,'mecord-r10');
  return{
    pairId:id(input.pairId,'pairId'),
    category:id(input.category,'category'),
    objectiveDigest:digest(input.objectiveDigest,'objectiveDigest'),
    startingStateDigest:digest(input.startingStateDigest,'startingStateDigest'),
    environmentDigest:digest(input.environmentDigest,'environmentDigest'),
    rubricDigest:digest(input.rubricDigest,'rubricDigest'),
    rubricFrozenBeforeExecution:bool(input.rubricFrozenBeforeExecution,'rubricFrozenBeforeExecution'),
    startingStateReproducible:bool(input.startingStateReproducible,'startingStateReproducible'),
    verifierBlindedToMode:bool(input.verifierBlindedToMode,'verifierBlindedToMode'),
    executionOrder:order,
    baseline,current,
    evidenceDigests:digestList(input.evidenceDigests,1000,'pair.evidenceDigests')
  };
}

function normalizeObservation(input:R10OutcomeObservation,mode:R10ExecutionMode):R10OutcomeObservation{
  if(!input||input.mode!==mode)throw invalid('Outcome observation mode is invalid.');
  const claimedComplete=bool(input.claimedComplete,'claimedComplete');
  const verifiedSuccess=bool(input.verifiedSuccess,'verifiedSuccess');
  if(verifiedSuccess&&!claimedComplete)throw invalid('Verified success requires a completion claim.');
  const interrupted=bool(input.interrupted,'interrupted');
  const recoverySucceeded=bool(input.recoverySucceeded,'recoverySucceeded');
  if(!interrupted&&recoverySucceeded)throw invalid('Recovery success requires an interruption.');
  const recoveryReceiptDigest=input.recoveryReceiptDigest===undefined?undefined:digest(input.recoveryReceiptDigest,'recoveryReceiptDigest');
  if(interrupted&&recoverySucceeded&&!recoveryReceiptDigest)throw invalid('Successful recovery requires a receipt digest.');
  const portableProof=bool(input.portableProof,'portableProof');
  const portableProofDigest=input.portableProofDigest===undefined?undefined:digest(input.portableProofDigest,'portableProofDigest');
  if(portableProof&&!portableProofDigest)throw invalid('Portable proof requires a proof digest.');
  const rollbackRequired=bool(input.rollbackRequired,'rollbackRequired');
  const rollbackSucceeded=bool(input.rollbackSucceeded,'rollbackSucceeded');
  if(!rollbackRequired&&rollbackSucceeded)throw invalid('Rollback success requires rollbackRequired.');
  const rollbackReceiptDigest=input.rollbackReceiptDigest===undefined?undefined:digest(input.rollbackReceiptDigest,'rollbackReceiptDigest');
  if(rollbackRequired&&rollbackSucceeded&&!rollbackReceiptDigest)throw invalid('Successful rollback requires a receipt digest.');
  const executorId=id(input.executorId,'executorId');
  const verifierId=id(input.verifierId,'verifierId');
  return{
    mode,
    executorId,verifierId,
    independentVerifier:bool(input.independentVerifier,'independentVerifier'),
    claimedComplete,verifiedSuccess,
    humanInterventionCount:integer(input.humanInterventionCount,0,1_000_000,'humanInterventionCount'),
    humanInterventionMinutes:finite(input.humanInterventionMinutes,0,1_000_000,'humanInterventionMinutes'),
    interrupted,recoverySucceeded,...(recoveryReceiptDigest?{recoveryReceiptDigest}:{}),
    authorityViolations:integer(input.authorityViolations,0,1_000_000,'authorityViolations'),
    portableProof,...(portableProofDigest?{portableProofDigest}:{}),
    predictedSuccessProbability:probability(input.predictedSuccessProbability,'predictedSuccessProbability'),
    rollbackRequired,rollbackSucceeded,...(rollbackReceiptDigest?{rollbackReceiptDigest}:{}),
    learningPolicyViolations:integer(input.learningPolicyViolations,0,1_000_000,'learningPolicyViolations'),
    resultDigest:digest(input.resultDigest,'resultDigest'),
    evidenceDigests:digestList(input.evidenceDigests,1000,'observation.evidenceDigests')
  };
}

function normalizeStandard(input:Partial<EngineeringCertificationStandard>):Partial<EngineeringCertificationStandard>{
  const out:Partial<EngineeringCertificationStandard>={};
  for(const key of ['minSuccessAbsoluteGain','minFalseCompletionRelativeReduction','minHumanInterventionRelativeReduction','minInterruptionRecoveryRate','minPortableProofRate','maxUncertaintyCalibrationError','minRollbackSuccessRate'] as const){
    if(input[key]!==undefined)out[key]=probability(input[key],key);
  }
  return out;
}
function bool(v:unknown,l:string):boolean{if(typeof v!=='boolean')throw invalid(l+' is invalid.');return v;}
function integer(v:unknown,min:number,max:number,l:string):number{const n=Number(v);if(!Number.isSafeInteger(n)||n<min||n>max)throw invalid(l+' is invalid.');return n;}
function finite(v:unknown,min:number,max:number,l:string):number{const n=Number(v);if(!Number.isFinite(n)||n<min||n>max)throw invalid(l+' is invalid.');return n;}
function probability(v:unknown,l:string):number{return finite(v,0,1,l);}
function id(v:unknown,l:string):string{const s=String(v??'');if(!/^[A-Za-z0-9._:@/+-]{1,512}$/.test(s))throw invalid(l+' is invalid.');return s;}
function gitSha(v:unknown,l:string):string{const s=String(v??'').toLowerCase();if(!/^[0-9a-f]{40}$/.test(s))throw invalid(l+' must be git SHA.');return s;}
function digest(v:unknown,l:string):string{const s=String(v??'').toLowerCase();if(!/^[0-9a-f]{64}$/.test(s))throw invalid(l+' must be SHA-256.');return s;}
function digestList(v:unknown,max:number,l:string):string[]{if(!Array.isArray(v)||v.length>max)throw invalid(l+' is invalid.');return[...new Set(v.map((x)=>digest(x,l)))].sort();}
function rate(n:number,d:number):number{return d===0?0:round(n/d);}
function mean(values:number[]):number{return values.length===0?0:round(values.reduce((a,b)=>a+b,0)/values.length);}
function round(v:number):number{return Math.round(v*1_000_000)/1_000_000;}
function hash(v:unknown):string{return crypto.createHash('sha256').update(canonicalJson(v),'utf8').digest('hex');}
function invalid(m:string):OperatorError{return new OperatorError('R10_EMPIRICAL_CAMPAIGN_INVALID',m);}
