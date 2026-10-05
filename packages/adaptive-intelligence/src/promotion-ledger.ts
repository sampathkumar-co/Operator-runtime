import crypto from 'node:crypto';
import type { LearningReceipt } from './contracts.ts';

export interface PromotionClaim {
  skillId:string;
  skillFingerprint:string;
  policyVersion:string;
  sourceRunIds:string[];
  verificationDigests:string[];
}

export interface PromotionLedgerEntry extends PromotionClaim {
  claimDigest:string;
  recordedAt:string;
}

export class PromotionLedger {
  #entries:PromotionLedgerEntry[]=[];
  #verificationOwner=new Map<string,string>();
  #runFingerprint=new Map<string,string>();
  #skillFingerprint=new Map<string,string>();
  #fingerprintSkill=new Map<string,string>();
  #claimDigests=new Set<string>();
  #clock:()=>Date;
  #maxEntries:number;

  constructor(options:{clock?:()=>Date;maxEntries?:number}={}){
    this.#clock=options.clock??(()=>new Date());
    this.#maxEntries=integer(options.maxEntries??100000,1,1_000_000,'maxEntries');
  }

  record(receipt:LearningReceipt,skillFingerprintInput:string):PromotionLedgerEntry{
    if(!receipt.promoted) throw new Error('Only promoted learning receipts may enter the promotion ledger.');
    const skillFingerprint=sha256(skillFingerprintInput,'skillFingerprint');
    const claim:PromotionClaim={
      skillId:bounded(receipt.skillId,256,'skillId'),
      skillFingerprint,
      policyVersion:bounded(receipt.policyVersion,256,'policyVersion'),
      sourceRunIds:unique(receipt.sourceRunIds.map(v=>bounded(v,512,'sourceRunId'))),
      verificationDigests:unique(receipt.verificationDigests.map(v=>sha256(v,'verificationDigest')))
    };
    if(claim.sourceRunIds.length===0||claim.verificationDigests.length===0){
      throw new Error('Promotion claim requires source runs and verification digests.');
    }

    const priorFingerprint=this.#skillFingerprint.get(claim.skillId);
    if(priorFingerprint&&priorFingerprint!==skillFingerprint){
      throw new Error('Skill id cannot be rebound to a different semantic fingerprint.');
    }
    const priorSkill=this.#fingerprintSkill.get(skillFingerprint);
    if(priorSkill&&priorSkill!==claim.skillId){
      throw new Error('Semantic skill fingerprint cannot be aliased to a different skill id.');
    }

    for(const digest of claim.verificationDigests){
      const owner=this.#verificationOwner.get(digest);
      if(owner&&owner!==skillFingerprint){
        throw new Error('Verification receipt replay across different skill fingerprints is rejected.');
      }
    }
    for(const runId of claim.sourceRunIds){
      const owner=this.#runFingerprint.get(runId);
      if(owner&&owner!==skillFingerprint){
        throw new Error('Source run cannot promote conflicting skill fingerprints.');
      }
    }

    const claimDigest=crypto.createHash('sha256').update(JSON.stringify({
      ...claim,
      sourceRunIds:[...claim.sourceRunIds].sort(),
      verificationDigests:[...claim.verificationDigests].sort()
    })).digest('hex');
    if(this.#claimDigests.has(claimDigest)) throw new Error('Equivalent promotion claim replay is rejected.');
    if(this.#entries.length>=this.#maxEntries) throw new Error('Promotion ledger capacity exceeded.');

    for(const digest of claim.verificationDigests) this.#verificationOwner.set(digest,skillFingerprint);
    for(const runId of claim.sourceRunIds) this.#runFingerprint.set(runId,skillFingerprint);
    this.#skillFingerprint.set(claim.skillId,skillFingerprint);
    this.#fingerprintSkill.set(skillFingerprint,claim.skillId);
    this.#claimDigests.add(claimDigest);

    const entry:PromotionLedgerEntry={...claim,claimDigest,recordedAt:this.#clock().toISOString()};
    this.#entries.push(entry);
    return structuredClone(entry);
  }

  snapshot():PromotionLedgerEntry[]{
    return this.#entries.map(entry=>structuredClone(entry));
  }

  verificationOwner(digestInput:string):string|undefined{
    return this.#verificationOwner.get(sha256(digestInput,'verificationDigest'));
  }

  fingerprintForSkill(skillIdInput:string):string|undefined{
    return this.#skillFingerprint.get(bounded(skillIdInput,256,'skillId'));
  }
}

function bounded(input:unknown,max:number,label:string):string{
  const value=String(input??'');
  if(!value||value.length>max) throw new Error(label+' is invalid.');
  return value;
}
function sha256(input:unknown,label:string):string{
  const value=String(input??'').toLowerCase();
  if(!/^[0-9a-f]{64}$/.test(value)) throw new Error(label+' must be SHA-256.');
  return value;
}
function unique(values:string[]):string[]{return [...new Set(values)].sort();}
function integer(input:unknown,min:number,max:number,label:string):number{
  const value=Number(input);
  if(!Number.isSafeInteger(value)||value<min||value>max) throw new Error(label+' is invalid.');
  return value;
}
