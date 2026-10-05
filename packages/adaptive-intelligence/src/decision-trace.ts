import crypto from 'node:crypto';
import type { EvidenceRef } from './contracts.ts';

export type DecisionMode='SHADOW'|'CONTROL';
export type DecisionKind='OBSERVATION'|'STRATEGY'|'RECOVERY'|'PROGRESS'|'LEARNING';

export interface DecisionTraceInput {
  mode:DecisionMode;
  kind:DecisionKind;
  taskId:string;
  policyVersion:string;
  selectedId?:string;
  alternatives?:string[];
  reason:string;
  evidence:EvidenceRef[];
  authoritySnapshotDigest:string;
  inputStateDigest:string;
}

export interface DecisionTraceRecord extends DecisionTraceInput {
  id:string;
  createdAt:string;
  decisionDigest:string;
}

export class DecisionTraceLog {
  #records:DecisionTraceRecord[]=[];
  #maxRecords:number;
  #clock:()=>Date;

  constructor(options:{maxRecords?:number;clock?:()=>Date}={}){
    this.#maxRecords=integer(options.maxRecords??10000,1,1000000,'maxRecords');
    this.#clock=options.clock??(()=>new Date());
  }

  append(input:DecisionTraceInput):DecisionTraceRecord{
    const normalized=normalize(input);
    const createdAt=this.#clock().toISOString();
    const decisionDigest=crypto.createHash('sha256').update(JSON.stringify({
      ...normalized,
      evidence:[...normalized.evidence].map(e=>e.digest).sort()
    })).digest('hex');
    const record:DecisionTraceRecord={
      ...normalized,
      id:crypto.randomUUID(),
      createdAt,
      decisionDigest
    };
    this.#records.push(record);
    if(this.#records.length>this.#maxRecords) this.#records.splice(0,this.#records.length-this.#maxRecords);
    return structuredClone(record);
  }

  recent(limitInput=100):DecisionTraceRecord[]{
    const limit=integer(limitInput,1,1000,'limit');
    return this.#records.slice(-limit).reverse().map(r=>structuredClone(r));
  }
}

function normalize(input:DecisionTraceInput):DecisionTraceInput{
  if(!input||typeof input!=='object') throw new Error('decision trace input is required.');
  if(!['SHADOW','CONTROL'].includes(input.mode)) throw new Error('decision mode is invalid.');
  if(!['OBSERVATION','STRATEGY','RECOVERY','PROGRESS','LEARNING'].includes(input.kind)) throw new Error('decision kind is invalid.');
  return {
    mode:input.mode,
    kind:input.kind,
    taskId:bounded(input.taskId,512,'taskId'),
    policyVersion:bounded(input.policyVersion,256,'policyVersion'),
    ...(input.selectedId?{selectedId:bounded(input.selectedId,512,'selectedId')}:{}),
    ...(input.alternatives?{alternatives:[...new Set(input.alternatives.map(v=>bounded(v,512,'alternativeId')))].sort()}:{}),
    reason:bounded(input.reason,4096,'reason'),
    evidence:[...new Map((input.evidence??[]).map(e=>[e.digest,e])).values()],
    authoritySnapshotDigest:sha256(input.authoritySnapshotDigest,'authoritySnapshotDigest'),
    inputStateDigest:sha256(input.inputStateDigest,'inputStateDigest')
  };
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
function integer(input:unknown,min:number,max:number,label:string):number{
  const value=Number(input);
  if(!Number.isSafeInteger(value)||value<min||value>max) throw new Error(label+' is invalid.');
  return value;
}
