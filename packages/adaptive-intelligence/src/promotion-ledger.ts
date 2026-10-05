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

  static fromSnapshot(
    entriesInput:PromotionLedgerEntry[],
    options:{clock?:()=>Date;maxEntries?:number}={}
  ):PromotionLedger{
    if(!Array.isArray(entriesInput)||entriesInput.length>1_000_000) throw new Error('Promotion ledger snapshot is invalid.');
    const ledger=new PromotionLedger(options);
    if(entriesInput.length>ledger.#maxEntries) throw new Error('Promotion ledger snapshot exceeds configured capacity.');
    for(const entry of entriesInput){
      ledger.#restoreEntry(entry);
    }
    return ledger;
  }

  record(receipt:LearningReceipt,skillFingerprintInput:string):PromotionLedgerEntry{
    if(!receipt.promoted) throw new Error('Only promoted learning receipts may enter the promotion ledger.');
    const claim=normalizeClaim({
      skillId:receipt.skillId,
      skillFingerprint:skillFingerprintInput,
      policyVersion:receipt.policyVersion,
      sourceRunIds:receipt.sourceRunIds,
      verificationDigests:receipt.verificationDigests
    });
    const digest=claimDigest(claim);
    const recordedAt=this.#clock().toISOString();
    this.#acceptClaim(claim,digest,recordedAt);
    return structuredClone(this.#entries[this.#entries.length-1]!);
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

  #restoreEntry(entryInput:PromotionLedgerEntry):void{
    if(!entryInput||typeof entryInput!=='object') throw new Error('Promotion ledger entry is invalid.');
    const claim=normalizeClaim(entryInput);
    const recordedAt=validIso(entryInput.recordedAt,'recordedAt');
    const digest=sha256(entryInput.claimDigest,'claimDigest');
    const actual=claimDigest(claim);
    if(!timingSafeHexEqual(actual,digest)) throw new Error('Promotion ledger claim digest mismatch.');
    this.#acceptClaim(claim,digest,recordedAt);
  }

  #acceptClaim(claim:PromotionClaim,digest:string,recordedAt:string):void{
    if(claim.sourceRunIds.length===0||claim.verificationDigests.length===0){
      throw new Error('Promotion claim requires source runs and verification digests.');
    }

    const priorFingerprint=this.#skillFingerprint.get(claim.skillId);
    if(priorFingerprint&&priorFingerprint!==claim.skillFingerprint){
      throw new Error('Skill id cannot be rebound to a different semantic fingerprint.');
    }
    const priorSkill=this.#fingerprintSkill.get(claim.skillFingerprint);
    if(priorSkill&&priorSkill!==claim.skillId){
      throw new Error('Semantic skill fingerprint cannot be aliased to a different skill id.');
    }

    for(const digestValue of claim.verificationDigests){
      const owner=this.#verificationOwner.get(digestValue);
      if(owner&&owner!==claim.skillFingerprint){
        throw new Error('Verification receipt replay across different skill fingerprints is rejected.');
      }
    }
    for(const runId of claim.sourceRunIds){
      const owner=this.#runFingerprint.get(runId);
      if(owner&&owner!==claim.skillFingerprint){
        throw new Error('Source run cannot promote conflicting skill fingerprints.');
      }
    }

    if(this.#claimDigests.has(digest)) throw new Error('Equivalent promotion claim replay is rejected.');
    if(this.#entries.length>=this.#maxEntries) throw new Error('Promotion ledger capacity exceeded.');

    for(const digestValue of claim.verificationDigests) this.#verificationOwner.set(digestValue,claim.skillFingerprint);
    for(const runId of claim.sourceRunIds) this.#runFingerprint.set(runId,claim.skillFingerprint);
    this.#skillFingerprint.set(claim.skillId,claim.skillFingerprint);
    this.#fingerprintSkill.set(claim.skillFingerprint,claim.skillId);
    this.#claimDigests.add(digest);
    this.#entries.push({...claim,claimDigest:digest,recordedAt});
  }
}

function normalizeClaim(input:PromotionClaim):PromotionClaim{
  const claim:PromotionClaim={
    skillId:bounded(input.skillId,256,'skillId'),
    skillFingerprint:sha256(input.skillFingerprint,'skillFingerprint'),
    policyVersion:bounded(input.policyVersion,256,'policyVersion'),
    sourceRunIds:unique((input.sourceRunIds??[]).map(v=>bounded(v,512,'sourceRunId'))),
    verificationDigests:unique((input.verificationDigests??[]).map(v=>sha256(v,'verificationDigest')))
  };
  return claim;
}
function claimDigest(claim:PromotionClaim):string{
  return crypto.createHash('sha256').update(JSON.stringify({
    ...claim,
    sourceRunIds:[...claim.sourceRunIds].sort(),
    verificationDigests:[...claim.verificationDigests].sort()
  })).digest('hex');
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
function validIso(input:unknown,label:string):string{
  const value=String(input??'');
  const parsed=Date.parse(value);
  if(!Number.isFinite(parsed)||new Date(parsed).toISOString()!==value) throw new Error(label+' must be ISO timestamp.');
  return value;
}
function timingSafeHexEqual(a:string,b:string):boolean{
  const aa=Buffer.from(a,'hex'),bb=Buffer.from(b,'hex');
  return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);
}
