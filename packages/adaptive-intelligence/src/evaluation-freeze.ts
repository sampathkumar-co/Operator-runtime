import crypto from 'node:crypto';

export interface EvaluationFreezeInput {
  sourceRevision: string;
  intelligencePolicyVersion: string;
  intelligencePolicyDigest: string;
  adaptiveStateDigest: string;
  authorityPolicyDigest: string;
  procedureSnapshotDigest: string;
  modelProvider: string;
  modelId: string;
  modelConfigDigest: string;
  environmentId: string;
  environmentDigest: string;
  runnerDigest: string;
  benchmarkId?: string;
  benchmarkDigest?: string;
  seed?: string | number;
}

export interface EvaluationFreezeManifest extends EvaluationFreezeInput {
  manifestDigest: string;
  frozenAt: string;
}

export function createEvaluationFreezeManifest(
  input:EvaluationFreezeInput,
  options:{clock?:()=>Date}={}
):EvaluationFreezeManifest{
  const normalized=normalizeInput(input);
  const manifestDigest=digestInput(normalized);
  const frozenAt=(options.clock??(()=>new Date()))();
  if(!Number.isFinite(frozenAt.getTime())) throw new Error('evaluation freeze clock returned an invalid date.');
  return {...normalized,manifestDigest,frozenAt:frozenAt.toISOString()};
}

export function verifyEvaluationFreezeManifest(
  input:EvaluationFreezeManifest
):boolean{
  try{
    if(!input||typeof input!=='object') return false;
    const normalized=normalizeInput(input);
    const supplied=sha256(input.manifestDigest,'manifestDigest');
    validIso(input.frozenAt,'frozenAt');
    const expected=digestInput(normalized);
    return timingSafeHexEqual(expected,supplied);
  }catch{
    return false;
  }
}

export function sameEvaluationCandidate(
  a:EvaluationFreezeManifest,
  b:EvaluationFreezeManifest
):boolean{
  if(!verifyEvaluationFreezeManifest(a)||!verifyEvaluationFreezeManifest(b)) return false;
  return timingSafeHexEqual(a.manifestDigest.toLowerCase(),b.manifestDigest.toLowerCase());
}

function normalizeInput(input:EvaluationFreezeInput):EvaluationFreezeInput{
  if(!input||typeof input!=='object') throw new Error('evaluation freeze input is required.');
  const hasBenchmarkId=input.benchmarkId!==undefined;
  const hasBenchmarkDigest=input.benchmarkDigest!==undefined;
  if(hasBenchmarkId!==hasBenchmarkDigest){
    throw new Error('benchmarkId and benchmarkDigest must be supplied together.');
  }
  return{
    sourceRevision:revision(input.sourceRevision),
    intelligencePolicyVersion:bounded(input.intelligencePolicyVersion,256,'intelligencePolicyVersion'),
    intelligencePolicyDigest:sha256(input.intelligencePolicyDigest,'intelligencePolicyDigest'),
    adaptiveStateDigest:sha256(input.adaptiveStateDigest,'adaptiveStateDigest'),
    authorityPolicyDigest:sha256(input.authorityPolicyDigest,'authorityPolicyDigest'),
    procedureSnapshotDigest:sha256(input.procedureSnapshotDigest,'procedureSnapshotDigest'),
    modelProvider:bounded(input.modelProvider,256,'modelProvider'),
    modelId:bounded(input.modelId,512,'modelId'),
    modelConfigDigest:sha256(input.modelConfigDigest,'modelConfigDigest'),
    environmentId:bounded(input.environmentId,512,'environmentId'),
    environmentDigest:sha256(input.environmentDigest,'environmentDigest'),
    runnerDigest:sha256(input.runnerDigest,'runnerDigest'),
    ...(hasBenchmarkId?{
      benchmarkId:bounded(input.benchmarkId,512,'benchmarkId'),
      benchmarkDigest:sha256(input.benchmarkDigest,'benchmarkDigest')
    }:{}),
    ...(input.seed!==undefined?{seed:boundedSeed(input.seed)}:{})
  };
}

function digestInput(input:EvaluationFreezeInput):string{
  return crypto.createHash('sha256').update(canonical(input)).digest('hex');
}

function canonical(input:EvaluationFreezeInput):string{
  return JSON.stringify({
    sourceRevision:input.sourceRevision,
    intelligencePolicyVersion:input.intelligencePolicyVersion,
    intelligencePolicyDigest:input.intelligencePolicyDigest,
    adaptiveStateDigest:input.adaptiveStateDigest,
    authorityPolicyDigest:input.authorityPolicyDigest,
    procedureSnapshotDigest:input.procedureSnapshotDigest,
    modelProvider:input.modelProvider,
    modelId:input.modelId,
    modelConfigDigest:input.modelConfigDigest,
    environmentId:input.environmentId,
    environmentDigest:input.environmentDigest,
    runnerDigest:input.runnerDigest,
    benchmarkId:input.benchmarkId??null,
    benchmarkDigest:input.benchmarkDigest??null,
    seed:input.seed===undefined?null:String(input.seed)
  });
}
function revision(input:unknown):string{
  const value=String(input??'');
  if(!/^[0-9a-f]{7,64}$/i.test(value)) throw new Error('sourceRevision is invalid.');
  return value.toLowerCase();
}
function sha256(input:unknown,label:string):string{
  const value=String(input??'').toLowerCase();
  if(!/^[0-9a-f]{64}$/.test(value)) throw new Error(label+' must be SHA-256.');
  return value;
}
function bounded(input:unknown,max:number,label:string):string{
  if(typeof input!=='string') throw new Error(label+' must be a string.');
  const value=input;
  if(!value||value.length>max) throw new Error(label+' is invalid.');
  return value;
}
function boundedSeed(input:string|number):string{
  if(typeof input==='number'){
    if(!Number.isSafeInteger(input)) throw new Error('numeric seed must be a safe integer.');
    return String(input);
  }
  if(typeof input==='string'){
    if(!input||input.length>256) throw new Error('seed is invalid.');
    return input;
  }
  throw new Error('seed must be a string or safe integer.');
}
function validIso(input:unknown,label:string):string{
  if(typeof input!=='string') throw new Error(label+' must be an ISO timestamp.');
  const parsed=Date.parse(input);
  if(!Number.isFinite(parsed)||new Date(parsed).toISOString()!==input) throw new Error(label+' must be an ISO timestamp.');
  return input;
}
function timingSafeHexEqual(a:string,b:string):boolean{
  const aa=Buffer.from(a,'hex'),bb=Buffer.from(b,'hex');
  return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);
}
