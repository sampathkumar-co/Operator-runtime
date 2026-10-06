import { OperatorError } from './errors.ts';
import type { ProofLevel } from './evidence-pack.ts';

export type ProofEvidenceClass =
  | 'DETERMINISTIC_POLICY'
  | 'STATIC_ANALYSIS'
  | 'TYPE_SYSTEM'
  | 'STRUCTURAL_DIFF'
  | 'CRYPTOGRAPHIC_RECEIPT'
  | 'INDEPENDENT_TEST'
  | 'RUNTIME_PROBE'
  | 'INDEPENDENT_VERIFIER'
  | 'MODEL_INFERENCE';

export interface ProofEvidenceRef {
  artifactId:string;
  evidenceClass:ProofEvidenceClass;
  passed:boolean;
  independent:boolean;
}

export interface ProofKernelDecision {
  level:ProofLevel;
  artifactIds:string[];
  reason:string;
}

const DETERMINISTIC=new Set<ProofEvidenceClass>(['DETERMINISTIC_POLICY','STATIC_ANALYSIS','TYPE_SYSTEM','STRUCTURAL_DIFF','CRYPTOGRAPHIC_RECEIPT']);
const EMPIRICAL=new Set<ProofEvidenceClass>(['INDEPENDENT_TEST','RUNTIME_PROBE','INDEPENDENT_VERIFIER']);

export function evaluateProofClaim(input:{evidence:ProofEvidenceRef[]; inferred?:boolean}):ProofKernelDecision{
  if(!Array.isArray(input.evidence)||input.evidence.length>1000)throw invalid('Proof evidence is invalid.');
  const evidence=input.evidence.map(normalizeEvidence);
  const failed=evidence.filter(e=>!e.passed);
  const passed=evidence.filter(e=>e.passed);
  const artifactIds=[...new Set(evidence.map(e=>e.artifactId))].sort();
  if(failed.length>0)return{level:'CONTRADICTED',artifactIds,reason:'At least one supplied verifier/evidence source contradicts the claim.'};
  if(passed.length===0)return{level:input.inferred?'INFERRED':'UNKNOWN',artifactIds,reason:input.inferred?'Claim is inference-only.':'No evidence establishes the claim.'};
  if(passed.every(e=>DETERMINISTIC.has(e.evidenceClass))&&passed.some(e=>e.independent)){
    return{level:'PROVEN',artifactIds,reason:'Claim is supported only by deterministic evidence and includes an independent source.'};
  }
  if(passed.some(e=>EMPIRICAL.has(e.evidenceClass)&&e.independent)){
    return{level:'EMPIRICALLY_VERIFIED',artifactIds,reason:'Claim was independently established through test/probe/verifier evidence.'};
  }
  const independentClasses=new Set(passed.filter(e=>e.independent).map(e=>e.evidenceClass));
  if(independentClasses.size>=2)return{level:'CORROBORATED',artifactIds,reason:'Claim is corroborated by multiple independent evidence classes.'};
  if(passed.every(e=>e.evidenceClass==='MODEL_INFERENCE'))return{level:'INFERRED',artifactIds,reason:'Only model inference supports the claim.'};
  return{level:'CORROBORATED',artifactIds,reason:'Evidence supports the claim but does not satisfy the PROVEN or EMPIRICALLY_VERIFIED criteria.'};
}
function normalizeEvidence(e:ProofEvidenceRef):ProofEvidenceRef{
 if(!e||!/^[0-9a-f]{64}$/i.test(e.artifactId)||!['DETERMINISTIC_POLICY','STATIC_ANALYSIS','TYPE_SYSTEM','STRUCTURAL_DIFF','CRYPTOGRAPHIC_RECEIPT','INDEPENDENT_TEST','RUNTIME_PROBE','INDEPENDENT_VERIFIER','MODEL_INFERENCE'].includes(e.evidenceClass)||typeof e.passed!=='boolean'||typeof e.independent!=='boolean')throw invalid('Proof evidence entry is invalid.');
 return{...e,artifactId:e.artifactId.toLowerCase()};
}
function invalid(m:string):OperatorError{return new OperatorError('PROOF_KERNEL_INPUT_INVALID',m);}
