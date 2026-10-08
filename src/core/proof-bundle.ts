import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import type { ProofLevel } from './evidence-pack.ts';
import { OperatorError } from './errors.ts';

export interface ProofBundleBody {
  objective:{id:string;statement:string};
  constraints:string[];
  authority:{
    leaseId:string;
    principalId:string;
    purpose:string;
    authorityDigest:string;
    expiresAt:string;
    artifactIds:string[];
  };
  planLineage:{planId:string;decisionDigest:string;twinId?:string;twinStateDigest?:string};
  preconditions:Array<{id:string;level:ProofLevel;artifactIds:string[]}>;
  actionJournal:Array<{
    actionId:string;
    effect:'read'|'create'|'update'|'delete'|'external';
    resourceKey?:string;
    beforeDigest?:string;
    afterDigest?:string;
    artifactIds:string[];
  }>;
  verification:Array<{claimId:string;level:ProofLevel;artifactIds:string[];verifier:string;independent:boolean}>;
  residualUncertainty:string[];
  rollbackStatus:'NOT_APPLICABLE'|'AVAILABLE'|'COMPLETED'|'FAILED'|'UNKNOWN';
  createdAt:string;
}

export interface SignedProofBundle {
  schemaVersion:1;
  body:ProofBundleBody;
  digest:string;
  signerKeyId:string;
  signature:string;
}

export function createSignedProofBundle(
  input:ProofBundleBody,
  signer:{keyId:string;privateKeyPem:string}
):SignedProofBundle{
  const body=normalizeBody(input);
  const signerKeyId=id(signer.keyId,'signerKeyId');
  if(typeof signer.privateKeyPem!=='string'||!signer.privateKeyPem.includes('PRIVATE KEY'))throw invalid('private signing key is invalid.');
  const digest=hash(body);
  let signature:string;
  try{
    signature=crypto.sign(null,Buffer.from(digest,'hex'),signer.privateKeyPem).toString('base64url');
  }catch{
    throw invalid('proof bundle signing failed.');
  }
  return{schemaVersion:1,body,digest,signerKeyId,signature};
}

export function verifySignedProofBundle(
  bundleInput:SignedProofBundle,
  input:{publicKeyPem:string;artifactBytes:Record<string,string|Uint8Array>}
):{valid:boolean;reasons:string[];digest:string}{
  const reasons:string[]=[];
  let body:ProofBundleBody;
  try{body=normalizeBody(bundleInput.body);}catch(error){return{valid:false,reasons:[error instanceof Error?error.message:String(error)],digest:''};}
  const digest=hash(body);
  if(bundleInput.schemaVersion!==1)reasons.push('Proof bundle schema version is invalid.');
  if(bundleInput.digest!==digest)reasons.push('Proof bundle digest does not match its canonical body.');
  if(!idOrFalse(bundleInput.signerKeyId))reasons.push('Proof bundle signer key id is invalid.');
  try{
    if(!crypto.verify(null,Buffer.from(digest,'hex'),input.publicKeyPem,Buffer.from(bundleInput.signature,'base64url'))){
      reasons.push('Proof bundle signature is invalid.');
    }
  }catch{
    reasons.push('Proof bundle signature could not be verified.');
  }

  const referenced=collectArtifactIds(body);
  for(const artifactId of referenced){
    const bytes=input.artifactBytes[artifactId];
    if(bytes===undefined){reasons.push('Referenced artifact '+artifactId+' is missing from external verification input.');continue;}
    const actual=crypto.createHash('sha256').update(typeof bytes==='string'?Buffer.from(bytes,'utf8'):Buffer.from(bytes)).digest('hex');
    if(actual!==artifactId)reasons.push('Referenced artifact '+artifactId+' failed SHA-256 verification.');
  }
  return{valid:reasons.length===0,reasons,digest};
}

export function collectArtifactIds(bodyInput:ProofBundleBody):string[]{
  const body=normalizeBody(bodyInput);
  return[...new Set([
    ...body.authority.artifactIds,
    ...body.preconditions.flatMap((row)=>row.artifactIds),
    ...body.actionJournal.flatMap((row)=>row.artifactIds),
    ...body.verification.flatMap((row)=>row.artifactIds)
  ])].sort();
}

function normalizeBody(input:ProofBundleBody):ProofBundleBody{
  if(!input||typeof input!=='object')throw invalid('proof bundle body is invalid.');
  const objective={id:id(input.objective?.id,'objective id'),statement:text(input.objective?.statement,16_384,'objective statement')};
  const constraints=listText(input.constraints,1000,4096,'constraints');
  const authority={
    leaseId:id(input.authority?.leaseId,'authority leaseId'),
    principalId:id(input.authority?.principalId,'authority principalId'),
    purpose:text(input.authority?.purpose,4096,'authority purpose'),
    authorityDigest:digest(input.authority?.authorityDigest,'authority digest'),
    expiresAt:iso(input.authority?.expiresAt,'authority expiresAt'),
    artifactIds:digests(input.authority?.artifactIds,'authority artifactIds')
  };
  const planLineage={
    planId:id(input.planLineage?.planId,'planId'),
    decisionDigest:digest(input.planLineage?.decisionDigest,'decisionDigest'),
    ...(input.planLineage?.twinId!==undefined?{twinId:digest(input.planLineage.twinId,'twinId')}:{ }),
    ...(input.planLineage?.twinStateDigest!==undefined?{twinStateDigest:digest(input.planLineage.twinStateDigest,'twinStateDigest')}:{ })
  };
  const preconditions=normalizeClaims(input.preconditions,'precondition');
  const actionJournal=normalizeJournal(input.actionJournal);
  const verification=normalizeVerification(input.verification);
  const residualUncertainty=listText(input.residualUncertainty,1000,4096,'residualUncertainty');
  const rollbackStatus=input.rollbackStatus;
  if(!['NOT_APPLICABLE','AVAILABLE','COMPLETED','FAILED','UNKNOWN'].includes(rollbackStatus))throw invalid('rollbackStatus is invalid.');
  const createdAt=iso(input.createdAt,'createdAt');
  return{objective,constraints,authority,planLineage,preconditions,actionJournal,verification,residualUncertainty,rollbackStatus,createdAt};
}

function normalizeClaims(input:ProofBundleBody['preconditions'],label:string):ProofBundleBody['preconditions']{
  if(!Array.isArray(input)||input.length<1||input.length>1000)throw invalid(label+' list is invalid.');
  const ids=new Set<string>();
  return input.map((row)=>{
    const rid=id(row.id,label+' id');if(ids.has(rid))throw invalid(label+' ids must be unique.');ids.add(rid);
    return{id:rid,level:proofLevel(row.level),artifactIds:digests(row.artifactIds,label+' artifactIds')};
  });
}

function normalizeJournal(input:ProofBundleBody['actionJournal']):ProofBundleBody['actionJournal']{
  if(!Array.isArray(input)||input.length<1||input.length>10_000)throw invalid('action journal is invalid.');
  const ids=new Set<string>();
  return input.map((row)=>{
    const actionId=id(row.actionId,'actionId');if(ids.has(actionId))throw invalid('action journal action IDs must be unique.');ids.add(actionId);
    if(!['read','create','update','delete','external'].includes(row.effect))throw invalid('action journal effect is invalid.');
    return{
      actionId,effect:row.effect,
      ...(row.resourceKey!==undefined?{resourceKey:text(row.resourceKey,4096,'resourceKey')}:{ }),
      ...(row.beforeDigest!==undefined?{beforeDigest:digest(row.beforeDigest,'beforeDigest')}:{ }),
      ...(row.afterDigest!==undefined?{afterDigest:digest(row.afterDigest,'afterDigest')}:{ }),
      artifactIds:digests(row.artifactIds,'journal artifactIds')
    };
  });
}

function normalizeVerification(input:ProofBundleBody['verification']):ProofBundleBody['verification']{
  if(!Array.isArray(input)||input.length<1||input.length>1000)throw invalid('verification list is invalid.');
  const ids=new Set<string>();
  return input.map((row)=>{
    const claimId=id(row.claimId,'claimId');
    if(ids.has(claimId))throw invalid('verification claim ids must be unique.');
    ids.add(claimId);
    return{
      claimId,
      level:proofLevel(row.level),
      artifactIds:digests(row.artifactIds,'verification artifactIds'),
      verifier:id(row.verifier,'verifier'),
      independent:row.independent===true
    };
  });
}

function proofLevel(v:unknown):ProofLevel{
  const allowed:ProofLevel[]=['PROVEN','EMPIRICALLY_VERIFIED','CORROBORATED','INFERRED','UNKNOWN','CONTRADICTED'];
  if(typeof v!=='string'||!allowed.includes(v as ProofLevel))throw invalid('proof level is invalid.');
  return v as ProofLevel;
}
function digests(v:unknown,label:string):string[]{if(!Array.isArray(v)||v.length>10_000)throw invalid(label+' is invalid.');return[...new Set(v.map((x)=>digest(x,label)))].sort();}
function listText(v:unknown,maxItems:number,maxBytes:number,label:string):string[]{if(!Array.isArray(v)||v.length>maxItems)throw invalid(label+' is invalid.');return[...new Set(v.map((x)=>text(x,maxBytes,label)))];}
function id(v:unknown,label:string):string{const s=String(v??'');if(!/^[A-Za-z0-9._:@/+\-=]{1,512}$/.test(s))throw invalid(label+' is invalid.');return s;}
function idOrFalse(v:unknown):boolean{try{id(v,'id');return true;}catch{return false;}}
function text(v:unknown,max:number,label:string):string{if(typeof v!=='string'||!v.trim()||Buffer.byteLength(v,'utf8')>max||v.includes('\0'))throw invalid(label+' is invalid.');return v;}
function digest(v:unknown,label:string):string{const s=String(v??'').toLowerCase();if(!/^[0-9a-f]{64}$/.test(s))throw invalid(label+' is invalid.');return s;}
function iso(v:unknown,label:string):string{const s=String(v??'');if(!Number.isFinite(Date.parse(s))||new Date(s).toISOString()!==s)throw invalid(label+' is invalid.');return s;}
function hash(v:unknown):string{return crypto.createHash('sha256').update(canonicalJson(v),'utf8').digest('hex');}
function invalid(m:string):OperatorError{return new OperatorError('PROOF_BUNDLE_INVALID',m);}
