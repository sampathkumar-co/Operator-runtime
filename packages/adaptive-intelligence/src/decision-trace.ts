import crypto from 'node:crypto';
import type { EvidenceRef } from './contracts.ts';

export type DecisionMode='SHADOW'|'CONTROL';
export type DecisionKind='OBSERVATION'|'STRATEGY'|'RECOVERY'|'PROGRESS'|'LEARNING';

export interface DecisionTraceInput {
  mode:DecisionMode;
  kind:DecisionKind;
  taskId:string;
  policyVersion:string;
  decisionPointId?:string;
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

  static fromSnapshot(
    recordsInput:DecisionTraceRecord[],
    options:{maxRecords?:number;clock?:()=>Date}={}
  ):DecisionTraceLog{
    if(!Array.isArray(recordsInput)||recordsInput.length>1_000_000) throw new Error('decision trace snapshot is invalid.');
    const log=new DecisionTraceLog(options);
    if(recordsInput.length>log.#maxRecords) throw new Error('Decision trace snapshot exceeds configured capacity.');
    const ids=new Set<string>();
    const digests=new Set<string>();
    for(const raw of recordsInput){
      if(!raw||typeof raw!=='object') throw new Error('Decision trace record is invalid.');
      const normalized=normalize(raw);
      const id=uuid(raw.id,'decision.id');
      const createdAt=validIso(raw.createdAt,'decision.createdAt');
      const decisionDigest=sha256(raw.decisionDigest,'decisionDigest');
      const actual=computeDecisionDigest(normalized,id,createdAt);
      if(!timingSafeHexEqual(actual,decisionDigest)) throw new Error('Decision trace digest mismatch.');
      if(ids.has(id)) throw new Error('Decision trace snapshot contains duplicate ids.');
      if(digests.has(decisionDigest)) throw new Error('Decision trace snapshot contains duplicate decision digests.');
      ids.add(id);
      digests.add(decisionDigest);
      log.#records.push({...normalized,id,createdAt,decisionDigest});
    }
    return log;
  }

  append(input:DecisionTraceInput):DecisionTraceRecord{
    const normalized=normalize(input);
    const id=crypto.randomUUID();
    const createdAt=this.#clock().toISOString();
    const decisionDigest=computeDecisionDigest(normalized,id,createdAt);
    const record:DecisionTraceRecord={...normalized,id,createdAt,decisionDigest};
    this.#records.push(record);
    if(this.#records.length>this.#maxRecords) this.#records.splice(0,this.#records.length-this.#maxRecords);
    return structuredClone(record);
  }

  recent(limitInput=100):DecisionTraceRecord[]{
    const limit=integer(limitInput,1,1000,'limit');
    return this.#records.slice(-limit).reverse().map(r=>structuredClone(r));
  }

  snapshot():DecisionTraceRecord[]{
    return this.#records.map(r=>structuredClone(r));
  }
}

function computeDecisionDigest(input:DecisionTraceInput,id:string,createdAt:string):string{
  return crypto.createHash('sha256').update(JSON.stringify({
    ...input,
    evidence:[...input.evidence].map(e=>e.digest).sort(),
    id,
    createdAt
  })).digest('hex');
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
    ...(input.decisionPointId?{decisionPointId:bounded(input.decisionPointId,512,'decisionPointId')}:{}),
    ...(input.selectedId?{selectedId:bounded(input.selectedId,512,'selectedId')}:{}),
    ...(input.alternatives?{alternatives:[...new Set(input.alternatives.map(v=>bounded(v,512,'alternativeId')))].sort()}:{}),
    reason:bounded(input.reason,4096,'reason'),
    evidence:[...new Map((input.evidence??[]).map(e=>[sha256(e.digest,'evidence.digest'),normalizeEvidence(e)])).values()],
    authoritySnapshotDigest:sha256(input.authoritySnapshotDigest,'authoritySnapshotDigest'),
    inputStateDigest:sha256(input.inputStateDigest,'inputStateDigest')
  };
}
function normalizeEvidence(input:EvidenceRef):EvidenceRef{
  return{
    digest:sha256(input.digest,'evidence.digest'),
    source:bounded(input.source,256,'evidence.source'),
    observedAt:validIso(input.observedAt,'evidence.observedAt'),
    ...(input.channel?{channel:bounded(input.channel,128,'evidence.channel')}:{}),
    ...(input.scope?{scope:bounded(input.scope,512,'evidence.scope')}: {}),
    ...(input.independenceKey?{independenceKey:bounded(input.independenceKey,512,'evidence.independenceKey')}: {})
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
function uuid(input:unknown,label:string):string{
  const value=String(input??'').toLowerCase();
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new Error(label+' must be a UUID.');
  return value;
}
function validIso(input:unknown,label:string):string{
  const value=String(input??'');
  const parsed=Date.parse(value);
  if(!Number.isFinite(parsed)||new Date(parsed).toISOString()!==value) throw new Error(label+' must be ISO timestamp.');
  return value;
}
function integer(input:unknown,min:number,max:number,label:string):number{
  const value=Number(input);
  if(!Number.isSafeInteger(value)||value<min||value>max) throw new Error(label+' is invalid.');
  return value;
}
function timingSafeHexEqual(a:string,b:string):boolean{
  const aa=Buffer.from(a,'hex'),bb=Buffer.from(b,'hex');
  return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);
}
