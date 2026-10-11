/** Bounded opt-in measurements complement the durable OperationTraceStore.
 * No sensitive request/response data; monotonic durations only within a host.
 */
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

export const PIPELINE_STAGES = [
 'hosted.ingress_auth','hosted.validation_serialization','relay.queue','relay.dispatch',
 'relay.network_to_device','local.request_processing','local.authorization_approval',
 'local.journal_audit','local.resource_lease','local.capability_routing',
 'browser.target_discovery','browser.cdp_connection','browser.cdp_roundtrip','browser.operation',
 'browser.dom_postcondition','kernel.verify_complete','relay.result_transport',
 'hosted.response_serialization','hosted.relay_roundtrip','model.tool_overhead_observed','unobservable_gap'
] as const;
export type PipelineStage = typeof PIPELINE_STAGES[number];
export type PipelineOrigin = 'hosted-mcp'|'relay-server'|'local-agent'|'browser'|'benchmark';
export type PipelineResult = 'ok'|'failed'|'timeout'|'cancelled';
export interface PipelineSpan {
 traceId:string; spanId:string; parentSpanId?:string;
 stage:PipelineStage; origin:PipelineOrigin; startTime:string; durationMs:number;
 result:PipelineResult; payloadBytes?:number; networkRoundTrips?:number;
 retries?:number; reconnects?:number; warm?:boolean;
}
export type PipelineSpanOptions=Pick<PipelineSpan,'stage'|'origin'> & {
 traceId?:string;payloadBytes?:number;networkRoundTrips?:number;
 retries?:number;reconnects?:number;warm?:boolean;
};
export interface PipelineReport {
 schemaVersion:1; clock:'process-monotonic'; crossHostClockReconciliation:'no-subtraction';
 capturedAt:string; metadata:{sourceSha:string;runtimeVersion:string;operatingSystem:string;
 chromeVersion:string;machine:string;conditions:string};
 retainedSpans:number; droppedSpans:number;
 stages:Array<{stage:PipelineStage;origin:PipelineOrigin;count:number;succeeded:number;
 successRate:number;meanMs:number;minMs:number;maxMs:number;p50Ms:number;
 p95Ms:number;p99Ms:number;sumMs:number;payloadBytes:number;
 networkRoundTrips:number;retries:number;reconnects:number;
 warm:number;cold:number;errors:number;timeouts:number;cancellations:number}>;
 unobservableStages:PipelineStage[];reconciliationNotice:string;
}
const context=new AsyncLocalStorage<{traceId:string;spanId:string}>();
const stages=new Set<string>(PIPELINE_STAGES);
const origins=new Set<string>(['hosted-mcp','relay-server','local-agent','browser','benchmark']);
export function opaqueTraceId(identity:string):string {
 return crypto.createHash('sha256').update(identity,'utf8').digest('hex');
}
const count=(n?:number)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=1_000_000_000?n:undefined;
export class PipelineLatencyRecorder {
 readonly enabled:boolean;readonly capacity:number;
 #slots:Array<PipelineSpan|undefined>;#size=0;#next=0;#dropped=0;
 constructor(options:{enabled?:boolean;capacity?:number}={}) {
  this.enabled=options.enabled??process.env.OPERATOR_PIPELINE_TRACE_ENABLED==='1';
  this.capacity=Math.max(1,Math.min(8192,Math.trunc(options.capacity??8192)));
  this.#slots=new Array(this.capacity);
 }
 get droppedSpans():number{return this.#dropped;}
 async measure<T>(options:PipelineSpanOptions,task:()=>Promise<T>|T):Promise<T> {
  if(!this.enabled)return await task();
  const inherited=context.getStore();
  const traceId=inherited?.traceId??opaqueTraceId(options.traceId??crypto.randomUUID());
  const spanId=crypto.randomUUID(),started=performance.now(),startTime=new Date().toISOString();
  let result:PipelineResult='ok';
  try{
   const value=await context.run({traceId,spanId},task);
   // Providers often represent a failed operation as a result rather than a thrown error.
   if(value && typeof value==='object' && 'ok' in value && value.ok===false){
    const error='error' in value?value.error:undefined;
    const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
    result=/TIMEOUT|DEADLINE/i.test(code)?'timeout':/ABORT|CANCEL/i.test(code)?'cancelled':'failed';
   }
   return value;
  }
  catch(error){
   const code=error&&typeof error==='object'&&'code'in error?String(error.code):'';
   result=/TIMEOUT|DEADLINE/i.test(code)?'timeout':/ABORT|CANCEL/i.test(code)?'cancelled':'failed';
   throw error;
  } finally {
   this.record({traceId,spanId,...(inherited?{parentSpanId:inherited.spanId}:{}),
    stage:options.stage,origin:options.origin,startTime,
    durationMs:Math.max(0,performance.now()-started),result,
    ...(options.payloadBytes===undefined?{}:{payloadBytes:options.payloadBytes}),
    ...(options.networkRoundTrips===undefined?{}:{networkRoundTrips:options.networkRoundTrips}),
    ...(options.retries===undefined?{}:{retries:options.retries}),
    ...(options.reconnects===undefined?{}:{reconnects:options.reconnects}),
    ...(options.warm===undefined?{}:{warm:options.warm})});
  }
 }
 record(span:PipelineSpan):void {
  if(!this.enabled||!stages.has(span.stage)||!origins.has(span.origin)
   ||!Number.isFinite(span.durationMs)||span.durationMs<0
   ||!/^[0-9a-f]{64}$/.test(span.traceId))return;
  const safe:PipelineSpan={traceId:span.traceId,spanId:span.spanId,
   ...(span.parentSpanId?{parentSpanId:span.parentSpanId}:{}),
   stage:span.stage,origin:span.origin,startTime:span.startTime,
   durationMs:span.durationMs,result:span.result,
   ...(count(span.payloadBytes)===undefined?{}:{payloadBytes:count(span.payloadBytes)}),
   ...(count(span.networkRoundTrips)===undefined?{}:{networkRoundTrips:count(span.networkRoundTrips)}),
   ...(count(span.retries)===undefined?{}:{retries:count(span.retries)}),
   ...(count(span.reconnects)===undefined?{}:{reconnects:count(span.reconnects)}),
   ...(span.warm===undefined?{}:{warm:span.warm===true})};
  if(this.#size===this.capacity)this.#dropped++;
  this.#slots[this.#next]=safe;this.#next=(this.#next+1)%this.capacity;
  this.#size=Math.min(this.capacity,this.#size+1);
 }
 snapshot():PipelineSpan[]{
  const first=(this.#next-this.#size+this.capacity)%this.capacity;
  return Array.from({length:this.#size},(_,i)=>({...this.#slots[(first+i)%this.capacity]!}));
 }
 report(metadata:PipelineReport['metadata']):PipelineReport{
  return summarizePipelineSpans(this.snapshot(),metadata,this.#dropped);
 }
}
export function summarizePipelineSpans(spans:readonly PipelineSpan[],
 metadata:PipelineReport['metadata'],droppedSpans=0):PipelineReport {
 const groups=new Map<string,PipelineSpan[]>();
 for(const s of spans){
  if(!stages.has(s.stage)||!origins.has(s.origin)||!Number.isFinite(s.durationMs)||s.durationMs<0)continue;
  const key=s.origin+':'+s.stage, group=groups.get(key)??[];
  group.push(s);groups.set(key,group);
 }
 const all:PipelineReport['stages']=[];
 for(const group of groups.values()){
  const values=group.map(s=>s.durationMs).sort((a,b)=>a-b);
  const n=values.length,sum=values.reduce((a,b)=>a+b,0),sample=group[0]!;
  const tally=(p:(s:PipelineSpan)=>boolean)=>group.filter(p).length;
  const total=(p:(s:PipelineSpan)=>number)=>group.reduce((a,s)=>a+p(s),0);
  const pct=(p:number)=>values[Math.min(n-1,Math.ceil(n*p)-1)]??0;
  const succeeded=tally(s=>s.result==='ok');
  all.push({stage:sample.stage,origin:sample.origin,count:n,succeeded,successRate:succeeded/n,
   meanMs:sum/n,minMs:values[0]!,maxMs:values[n-1]!,p50Ms:pct(.5),
   p95Ms:pct(.95),p99Ms:pct(.99),sumMs:sum,
   payloadBytes:total(s=>s.payloadBytes??0),networkRoundTrips:total(s=>s.networkRoundTrips??0),
   retries:total(s=>s.retries??0),reconnects:total(s=>s.reconnects??0),
   warm:tally(s=>s.warm===true),cold:tally(s=>s.warm===false),
   errors:tally(s=>s.result==='failed'),timeouts:tally(s=>s.result==='timeout'),
   cancellations:tally(s=>s.result==='cancelled')});
 }
 all.sort((a,b)=>b.sumMs-a.sumMs);
 const present=new Set(all.map(s=>s.stage));
 return {schemaVersion:1,clock:'process-monotonic',crossHostClockReconciliation:'no-subtraction',
  capturedAt:new Date().toISOString(),metadata:{...metadata},retainedSpans:spans.length,droppedSpans,
  stages:all,unobservableStages:PIPELINE_STAGES.filter(s=>!present.has(s)),
  reconciliationNotice:'Nested spans overlap parents. SumMs is sampled work, not additive end-to-end duration. Cross-host wall-clock offsets, uninstrumented gaps and model overhead remain unknown.'};
}
export function pipelineReportMarkdown(r:PipelineReport):string{
 const m=r.metadata;const safe=(v:string)=>String(v).replace(/[\r\n|<>]/g,' ').slice(0,160);
 const lines=['# Mecord Connect pipeline timing','',
  'SHA: '+safe(m.sourceSha),'Runtime: '+safe(m.runtimeVersion),
  'OS: '+safe(m.operatingSystem),'Chrome: '+safe(m.chromeVersion),
  'Machine: '+safe(m.machine),'Conditions: '+safe(m.conditions),
  'Generated: '+r.capturedAt,'Retained: '+r.retainedSpans+'; dropped: '+r.droppedSpans,'',
  '| Origin | Stage | N | Success | Mean ms | p50 | p95 | p99 | Sum ms | RTT | Retry | Reconnect | Timeout |',
  '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
 for(const s of r.stages)lines.push('| '+[s.origin,s.stage,s.count,s.successRate.toFixed(3),
  s.meanMs.toFixed(2),s.p50Ms.toFixed(2),s.p95Ms.toFixed(2),
  s.p99Ms.toFixed(2),s.sumMs.toFixed(2),s.networkRoundTrips,
  s.retries,s.reconnects,s.timeouts].join(' | ')+' |');
 lines.push('','Unobserved: '+r.unobservableStages.join(', '),'',r.reconciliationNotice,'');
 return lines.join('\n');
}
export const pipelineLatency=new PipelineLatencyRecorder();
