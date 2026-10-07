import { twinSupportsClaim, type TwinFidelityDimension } from './counterfactual-twin.ts';
import type { ReconstructedCounterfactualTwin } from './counterfactual-twin-runtime.ts';
import type { ProofLevel } from './evidence-pack.ts';
import { verifySignedProofBundle, type SignedProofBundle } from './proof-bundle.ts';

const ACCEPTABLE=new Set<ProofLevel>(['PROVEN','EMPIRICALLY_VERIFIED','CORROBORATED']);
const STRONG=new Set<ProofLevel>(['PROVEN','EMPIRICALLY_VERIFIED']);

export interface ProofCarryingExecutionDecision {
  allowed:boolean;
  reasons:string[];
  bundleDigest:string;
  twinId:string;
}

export function evaluateProofCarryingExecution(input:{
  twin:ReconstructedCounterfactualTwin;
  bundle:SignedProofBundle;
  publicKeyPem:string;
  artifactBytes:Record<string,string|Uint8Array>;
  requiredTwinDimensions:TwinFidelityDimension['dimension'][];
  irreversible:boolean;
  now:string;
}):ProofCarryingExecutionDecision{
  const reasons:string[]=[];
  const verification=verifySignedProofBundle(input.bundle,{publicKeyPem:input.publicKeyPem,artifactBytes:input.artifactBytes});
  if(!verification.valid)reasons.push(...verification.reasons);

  const support=twinSupportsClaim(input.twin.manifest,input.requiredTwinDimensions);
  for(const dimension of support.missing)reasons.push('Required twin dimension '+dimension+' is absent.');
  for(const dimension of support.partial)reasons.push('Required twin dimension '+dimension+' is partial.');

  if(input.bundle.body.authority.authorityDigest!==input.twin.manifest.authorityDigest){
    reasons.push('Proof authority digest does not match the counterfactual twin authority envelope.');
  }
  const now=Date.parse(input.now);
  if(!Number.isFinite(now))reasons.push('Evaluation time is invalid.');
  else if(Date.parse(input.bundle.body.authority.expiresAt)<=now)reasons.push('Proof authority lease is expired.');

  for(const precondition of input.bundle.body.preconditions){
    if(!ACCEPTABLE.has(precondition.level))reasons.push('Precondition '+precondition.id+' has insufficient proof level '+precondition.level+'.');
  }
  const independent=input.bundle.body.verification.filter((claim)=>claim.independent&&STRONG.has(claim.level));
  if(independent.length<1)reasons.push('At least one independent PROVEN or EMPIRICALLY_VERIFIED outcome is required.');

  if(input.bundle.body.rollbackStatus==='FAILED')reasons.push('Proof bundle records failed rollback.');
  if(input.irreversible){
    if(input.bundle.body.residualUncertainty.length>0)reasons.push('Irreversible execution cannot proceed with residual uncertainty.');
    if(input.bundle.body.rollbackStatus==='UNKNOWN')reasons.push('Irreversible execution requires explicit rollback/recovery status.');
    if(input.bundle.body.actionJournal.some((entry)=>entry.effect!=='read'&&entry.afterDigest===undefined)){
      reasons.push('Irreversible mutation journal entries require explicit after-state digests.');
    }
  }

  return{
    allowed:reasons.length===0,
    reasons:[...new Set(reasons)],
    bundleDigest:verification.digest||input.bundle.digest,
    twinId:input.twin.id
  };
}
