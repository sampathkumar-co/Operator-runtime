import crypto from 'node:crypto';
import type { BeliefView, PlanNode, VerificationReceiptRef } from './contracts.ts';

export interface CommitPermit {
  digest:string;
  goalId:string;
  nodeId:string;
  reversible:boolean;
  authoritySnapshotDigest?:string;
  issuedAt:string;
}

export interface CommitPreflightInput {
  goalId:string;
  node:PlanNode;
  beliefs:BeliefView[];
  authorizationReceipt?:VerificationReceiptRef;
  now?:string;
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
  validIso(now,'now');
  let authoritySnapshotDigest:string|undefined;
  if(!input.node.reversible){
    const receipt=input.authorizationReceipt;
    if(!receipt) throw new Error('irreversible action requires an independent authorization receipt.');
    normalizeReceipt(receipt,input.goalId,input.node.id);
    authoritySnapshotDigest=receipt.authoritySnapshotDigest.toLowerCase();
    if(input.node.verificationFactKeys.length===0){
      throw new Error('irreversible action requires explicit post-commit verification facts.');
    }
  }
  const payload={
    goalId:bounded(input.goalId,256,'goalId'),
    nodeId:input.node.id,
    reversible:input.node.reversible,
    authoritySnapshotDigest:authoritySnapshotDigest??null,
    issuedAt:now
  };
  return {
    digest:crypto.createHash('sha256').update(canonical(payload)).digest('hex'),
    goalId:payload.goalId,nodeId:payload.nodeId,reversible:payload.reversible,
    ...(authoritySnapshotDigest?{authoritySnapshotDigest}:{}),issuedAt:now
  };
}

export function validateCompletionReceipt(
  receipt:VerificationReceiptRef,
  goalId:string,
  nodeId:string
):VerificationReceiptRef{
  return normalizeReceipt(receipt,goalId,nodeId);
}

function normalizeReceipt(r:VerificationReceiptRef,goalId:string,nodeId:string):VerificationReceiptRef{
  if(!r||typeof r!=='object') throw new Error('verification receipt is required.');
  const out={
    digest:sha256(r.digest,'receipt.digest'),
    goalId:bounded(r.goalId,256,'receipt.goalId'),
    nodeId:bounded(r.nodeId,256,'receipt.nodeId'),
    verifierId:bounded(r.verifierId,512,'receipt.verifierId'),
    verifiedAt:validIso(r.verifiedAt,'receipt.verifiedAt'),
    authoritySnapshotDigest:sha256(r.authoritySnapshotDigest,'receipt.authoritySnapshotDigest')
  };
  if(out.goalId!==goalId||out.nodeId!==nodeId) throw new Error('verification receipt is bound to different goal/node lineage.');
  return out;
}
function canonical(v:unknown):string{
  if(v===null||typeof v!=='object') return JSON.stringify(v);
  if(Array.isArray(v)) return '['+v.map(canonical).join(',')+']';
  const o=v as Record<string,unknown>;
  return '{'+Object.keys(o).sort().map((k)=>JSON.stringify(k)+':'+canonical(o[k])).join(',')+'}';
}
function sha256(v:unknown,l:string):string{if(typeof v!=='string'||!/^[0-9a-fA-F]{64}$/.test(v))throw new Error(l+' must be SHA-256.');return v.toLowerCase();}
function bounded(v:unknown,m:number,l:string):string{if(typeof v!=='string'||!v||v.length>m)throw new Error(l+' is invalid.');return v;}
function validIso(v:unknown,l:string):string{if(typeof v!=='string')throw new Error(l+' is invalid.');const p=Date.parse(v);if(!Number.isFinite(p)||new Date(p).toISOString()!==v)throw new Error(l+' must be ISO timestamp.');return v;}
