import crypto from 'node:crypto';
import type { AuthorizationReceiptRef, BeliefView, PlanNode, VerificationReceiptRef } from './contracts.ts';
import { canonical } from './lineage.ts';

export interface CommitPermit {
  digest:string;
  goalId:string;
  planId:string;
  planVersion:number;
  nodeId:string;
  attempt:number;
  reversible:boolean;
  authoritySnapshotDigest?:string;
  issuedAt:string;
}

export interface CommitPreflightInput {
  goalId:string;
  planId:string;
  planVersion:number;
  node:PlanNode;
  attempt:number;
  beliefs:BeliefView[];
  currentAuthoritySnapshotDigest?:string;
  authorizationReceipt?:AuthorizationReceiptRef;
  authorizationReceiptMaxAgeMs?:number;
  now?:string;
}

export interface CompletionLineage {
  goalId:string;
  planId:string;
  planVersion:number;
  nodeId:string;
  attempt:number;
  executionDigest:string;
}

export function authorizeCommit(input:CommitPreflightInput):CommitPermit{
  if(input.node.kind!=='ACTION') throw new Error('commit protocol only authorizes ACTION nodes.');
  const beliefByFact=new Map(input.beliefs.map((b)=>[b.factKey,b]));
  for(const p of input.node.preconditions){
    const b=beliefByFact.get(p.factKey);
    if(!b||!['KNOWN','SUPPORTED'].includes(b.status)||b.confidence<(p.minimumConfidence??0.55)){
      throw new Error('commit blocked by unverified precondition: '+p.factKey);
    }
    if(p.expectedValueDigest&&b.selectedValueDigest!==p.expectedValueDigest){
      throw new Error('commit blocked by mismatched precondition: '+p.factKey);
    }
  }
  const now=input.now??new Date().toISOString();
  const nowMs=parseIso(now,'now');
  const attempt=integer(input.attempt,1,100,'attempt');
  const planVersion=integer(input.planVersion,1,Number.MAX_SAFE_INTEGER,'planVersion');
  let authoritySnapshotDigest:string|undefined;

  if(!input.node.reversible){
    const receipt=input.authorizationReceipt;
    if(!receipt) throw new Error('irreversible action requires an independent authorization receipt.');
    const currentAuthority=sha256(input.currentAuthoritySnapshotDigest,'currentAuthoritySnapshotDigest');
    const normalized=normalizeAuthorizationReceipt(receipt,{
      goalId:input.goalId,planId:input.planId,planVersion,nodeId:input.node.id
    });
    if(normalized.authoritySnapshotDigest!==currentAuthority){
      throw new Error('authorization receipt authority snapshot is stale.');
    }
    const maxAge=input.authorizationReceiptMaxAgeMs??300_000;
    if(!Number.isSafeInteger(maxAge)||maxAge<0||maxAge>86_400_000) throw new Error('authorizationReceiptMaxAgeMs is invalid.');
    const age=nowMs-Date.parse(normalized.authorizedAt);
    if(age<0||age>maxAge) throw new Error('authorization receipt is outside the allowed freshness window.');
    authoritySnapshotDigest=currentAuthority;
    if(input.node.verificationFactKeys.length===0){
      throw new Error('irreversible action requires explicit post-commit verification facts.');
    }
  }

  const payload={
    goalId:bounded(input.goalId,256,'goalId'),
    planId:bounded(input.planId,256,'planId'),
    planVersion,nodeId:input.node.id,attempt,reversible:input.node.reversible,
    authoritySnapshotDigest:authoritySnapshotDigest??null,issuedAt:now
  };
  return {
    digest:crypto.createHash('sha256').update(canonical(payload)).digest('hex'),
    goalId:payload.goalId,planId:payload.planId,planVersion,nodeId:payload.nodeId,attempt,
    reversible:payload.reversible,...(authoritySnapshotDigest?{authoritySnapshotDigest}:{}),issuedAt:now
  };
}

export function validateCompletionReceipt(
  receipt:VerificationReceiptRef,
  expected:CompletionLineage
):VerificationReceiptRef{
  if(!receipt||typeof receipt!=='object') throw new Error('verification receipt is required.');
  const out:VerificationReceiptRef={
    digest:sha256(receipt.digest,'receipt.digest'),
    goalId:bounded(receipt.goalId,256,'receipt.goalId'),
    planId:bounded(receipt.planId,256,'receipt.planId'),
    planVersion:integer(receipt.planVersion,1,Number.MAX_SAFE_INTEGER,'receipt.planVersion'),
    nodeId:bounded(receipt.nodeId,256,'receipt.nodeId'),
    attempt:integer(receipt.attempt,1,100,'receipt.attempt'),
    executionDigest:sha256(receipt.executionDigest,'receipt.executionDigest'),
    verifierId:bounded(receipt.verifierId,512,'receipt.verifierId'),
    verifiedAt:validIso(receipt.verifiedAt,'receipt.verifiedAt'),
    authoritySnapshotDigest:sha256(receipt.authoritySnapshotDigest,'receipt.authoritySnapshotDigest')
  };
  if(out.goalId!==expected.goalId||out.planId!==expected.planId||out.planVersion!==expected.planVersion||
     out.nodeId!==expected.nodeId||out.attempt!==expected.attempt||out.executionDigest!==expected.executionDigest){
    throw new Error('verification receipt is bound to different plan/node/attempt/execution lineage.');
  }
  return out;
}

function normalizeAuthorizationReceipt(
  r:AuthorizationReceiptRef,
  expected:{goalId:string;planId:string;planVersion:number;nodeId:string}
):AuthorizationReceiptRef{
  if(!r||typeof r!=='object') throw new Error('authorization receipt is required.');
  const out:AuthorizationReceiptRef={
    digest:sha256(r.digest,'authorization.digest'),
    goalId:bounded(r.goalId,256,'authorization.goalId'),
    planId:bounded(r.planId,256,'authorization.planId'),
    planVersion:integer(r.planVersion,1,Number.MAX_SAFE_INTEGER,'authorization.planVersion'),
    nodeId:bounded(r.nodeId,256,'authorization.nodeId'),
    authoritySnapshotDigest:sha256(r.authoritySnapshotDigest,'authorization.authoritySnapshotDigest'),
    authorizedAt:validIso(r.authorizedAt,'authorization.authorizedAt')
  };
  if(out.goalId!==expected.goalId||out.planId!==expected.planId||out.planVersion!==expected.planVersion||out.nodeId!==expected.nodeId){
    throw new Error('authorization receipt is bound to different plan/node lineage.');
  }
  return out;
}
function sha256(v:unknown,l:string):string{if(typeof v!=='string'||!/^[0-9a-fA-F]{64}$/.test(v))throw new Error(l+' must be SHA-256.');return v.toLowerCase();}
function bounded(v:unknown,m:number,l:string):string{if(typeof v!=='string'||!v||v.length>m)throw new Error(l+' is invalid.');return v;}
function integer(v:unknown,min:number,max:number,l:string):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)throw new Error(l+' is invalid.');return v;}
function validIso(v:unknown,l:string):string{parseIso(v,l);return v as string;}
function parseIso(v:unknown,l:string):number{if(typeof v!=='string')throw new Error(l+' is invalid.');const p=Date.parse(v);if(!Number.isFinite(p)||new Date(p).toISOString()!==v)throw new Error(l+' must be ISO timestamp.');return p;}
