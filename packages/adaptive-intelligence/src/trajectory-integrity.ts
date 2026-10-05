import crypto from 'node:crypto';
import type { CausalTransition } from './contracts.ts';
import { canonicalJson } from './versioned-state.ts';

export interface TrajectoryIntegrityRecord {
  sequence:number;
  transitionId:string;
  priorRecordDigest:string;
  transitionDigest:string;
  recordDigest:string;
}

export interface TrajectoryIntegrityVerification {
  ok:boolean;
  checked:number;
  firstInvalidSequence?:number;
  reason?:string;
}

const GENESIS='0'.repeat(64);

export function buildTrajectoryIntegrityChain(transitions:CausalTransition[]):TrajectoryIntegrityRecord[]{
  if(!Array.isArray(transitions)||transitions.length>1_000_000) throw new Error('transitions are invalid.');
  const records:TrajectoryIntegrityRecord[]=[];
  let prior=GENESIS;
  for(let sequence=0;sequence<transitions.length;sequence+=1){
    const transition=transitions[sequence]!;
    const transitionDigest=crypto.createHash('sha256').update(canonicalTransition(transition)).digest('hex');
    const recordDigest=crypto.createHash('sha256').update(canonicalJson({
      sequence,
      transitionId:transition.id,
      priorRecordDigest:prior,
      transitionDigest
    })).digest('hex');
    records.push({sequence,transitionId:transition.id,priorRecordDigest:prior,transitionDigest,recordDigest});
    prior=recordDigest;
  }
  return records;
}

export function verifyTrajectoryIntegrityChain(
  transitions:CausalTransition[],
  records:TrajectoryIntegrityRecord[]
):TrajectoryIntegrityVerification{
  if(transitions.length!==records.length){
    return {ok:false,checked:Math.min(transitions.length,records.length),reason:'Transition/record length mismatch.'};
  }
  let prior=GENESIS;
  for(let sequence=0;sequence<records.length;sequence+=1){
    const transition=transitions[sequence]!;
    const record=records[sequence]!;
    if(record.sequence!==sequence) return invalid(sequence,'Sequence mismatch.');
    if(record.transitionId!==transition.id) return invalid(sequence,'Transition id mismatch.');
    if(record.priorRecordDigest!==prior) return invalid(sequence,'Prior record digest mismatch.');
    const transitionDigest=crypto.createHash('sha256').update(canonicalTransition(transition)).digest('hex');
    if(!safeEqual(record.transitionDigest,transitionDigest)) return invalid(sequence,'Transition digest mismatch.');
    const recordDigest=crypto.createHash('sha256').update(canonicalJson({
      sequence,
      transitionId:transition.id,
      priorRecordDigest:prior,
      transitionDigest
    })).digest('hex');
    if(!safeEqual(record.recordDigest,recordDigest)) return invalid(sequence,'Record digest mismatch.');
    prior=record.recordDigest;
  }
  return {ok:true,checked:records.length};
}

function canonicalTransition(transition:CausalTransition):string{
  return canonicalJson({
    id:transition.id,
    before:transition.before,
    action:transition.action,
    outcome:transition.outcome,
    after:transition.after,
    delta:transition.delta,
    causalConfidence:transition.causalConfidence,
    recordedAt:transition.recordedAt
  });
}
function invalid(sequence:number,reason:string):TrajectoryIntegrityVerification{
  return {ok:false,checked:sequence,firstInvalidSequence:sequence,reason};
}
function safeEqual(a:string,b:string):boolean{
  if(!/^[0-9a-f]{64}$/.test(a)||! /^[0-9a-f]{64}$/.test(b)) return false;
  const aa=Buffer.from(a,'hex'),bb=Buffer.from(b,'hex');
  return crypto.timingSafeEqual(aa,bb);
}
