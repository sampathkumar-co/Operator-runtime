import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import {
  PipelineLatencyRecorder, opaqueTraceId, pipelineReportMarkdown,
  summarizePipelineSpans, PIPELINE_STAGES
} from '../src/core/pipeline-latency.ts';

const metadata={sourceSha:'synthetic-source-sha',runtimeVersion:'test',
 operatingSystem:process.platform,chromeVersion:'unavailable',machine:'synthetic-test',
 conditions:'synthetic local, no hosted/Chrome interactions'};

test('monotonic, parent-child, stable opaque trace identity and quantiles (30 observations)',async()=>{
 const recorder=new PipelineLatencyRecorder({enabled:true,capacity:64});
 const id='nonpublic-action-id';
 const values=[];
 for(let i=0;i<30;i++){
  await recorder.measure({traceId:id,stage:'browser.operation',origin:'browser',warm:i>0},
   async()=>await recorder.measure({stage:'browser.target_discovery',origin:'browser',networkRoundTrips:1},
    async()=>{await Promise.resolve();return i;}));
 }
 const spans=recorder.snapshot();
 assert.equal(spans.length,60);
 const parent=spans.filter(s=>s.stage==='browser.operation');
 const child=spans.filter(s=>s.stage==='browser.target_discovery');
 assert.equal(parent.length,30);
 assert.equal(child.length,30);
 assert.equal(new Set(parent.map(s=>s.traceId)).size,1);
 assert.equal(parent[0]!.traceId,opaqueTraceId(id));
 assert.notEqual(parent[0]!.traceId,id);
 assert.ok(child.every(c=>parent.some(p=>p.spanId===c.parentSpanId)));
 assert.ok(spans.every(s=>Number.isFinite(s.durationMs)&&s.durationMs>=0));
 assert.ok(spans.every(s=>/^[0-9a-f]{64}$/.test(s.traceId)));
 const report=recorder.report(metadata);
 assert.equal(report.stages.length,2);
 assert.ok(report.stages.every(s=>s.count===30&&s.p99Ms>=s.p95Ms&&s.p95Ms>=s.p50Ms));
 assert.ok(report.unobservableStages.includes('hosted.ingress_auth'));
 assert.equal(report.crossHostClockReconciliation,'no-subtraction');
 assert.ok(pipelineReportMarkdown(report).includes('Unobserved:'));
 values.push(...spans);
});

test('timeout, cancellation, failure preserved and classified without logging raw error',async()=>{
 const recorder=new PipelineLatencyRecorder({enabled:true});
 for(const code of ['RELAY_TIMEOUT','EXECUTION_ABORTED','PRIVATE_SECRET_ERROR']){
  await assert.rejects(recorder.measure({stage:'relay.result_transport',origin:'relay-server',traceId:'error-example'},
   async()=>{throw Object.assign(new Error('secret-token-must-never-appear'),{code});}));
 }
 const report=recorder.report(metadata);
 assert.equal(report.stages[0]!.timeouts,1);
 assert.equal(report.stages[0]!.cancellations,1);
 assert.equal(report.stages[0]!.errors,1);
 assert.equal(report.stages[0]!.successRate,0);
 assert.doesNotMatch(JSON.stringify(recorder.snapshot()),/secret-token|PRIVATE_SECRET_ERROR/);
});

test('bounded memory ring, strict privacy field projection and invalid measurements ignored',()=>{
 const recorder=new PipelineLatencyRecorder({enabled:true,capacity:3});
 const traceId=opaqueTraceId('sensitive-identity');
 for(let i=0;i<5;i++){
  recorder.record({traceId,spanId:crypto.randomUUID(),stage:'relay.queue',origin:'relay-server',
   startTime:new Date().toISOString(),durationMs:i,result:'ok',
   payloadBytes:25,networkRoundTrips:1,
   ...({authorization:'Bearer private-secret',value:'private-form-value',url:'https://private'} as object)});
 }
 assert.equal(recorder.snapshot().length,3);
 assert.equal(recorder.droppedSpans,2);
 assert.deepEqual(recorder.snapshot().map(s=>s.durationMs),[2,3,4]);
 assert.doesNotMatch(JSON.stringify(recorder.snapshot()),/private-secret|private-form-value|https:/);
 recorder.record({traceId:'raw:secret',spanId:'bad',stage:'relay.queue',origin:'relay-server',
   startTime:new Date().toISOString(),durationMs:NaN,result:'ok'});
 assert.equal(recorder.snapshot().length,3);
});

test('disabled tracing does not record spans or alter operation results',async()=>{
 const recorder=new PipelineLatencyRecorder({enabled:false});
 assert.equal(await recorder.measure({stage:'browser.operation',origin:'browser',traceId:'secret'},()=>42),42);
 assert.equal(recorder.snapshot().length,0);
});

test('report ranks observed work but does not falsely reconcile overlapping cross-host spans',()=>{
 const traceId=opaqueTraceId('same-across-machines');
 const base={traceId,spanId:'parent',startTime:new Date().toISOString(),result:'ok' as const};
 const report=summarizePipelineSpans([
  {...base,stage:'hosted.relay_roundtrip',origin:'hosted-mcp',durationMs:100},
  {...base,spanId:'child',parentSpanId:'parent',stage:'relay.queue',origin:'relay-server',durationMs:60}
 ],metadata);
 assert.equal(report.stages[0]!.stage,'hosted.relay_roundtrip');
 assert.equal(report.stages[1]!.stage,'relay.queue');
 assert.equal(report.stages[0]!.sumMs,100);
 assert.equal(report.stages[1]!.sumMs,60);
 assert.ok(report.reconciliationNotice.includes('not additive'));
});

test('tracing overhead is measurable and bounded on a pure no-I/O workload',async()=>{
 const disabled=new PipelineLatencyRecorder({enabled:false});
 const enabled=new PipelineLatencyRecorder({enabled:true,capacity:8192});
 const iterations=1000;
 const once=async(recorder:PipelineLatencyRecorder)=>{
  const start=performance.now();
  for(let i=0;i<iterations;i++)
   await recorder.measure({stage:'browser.operation',origin:'benchmark',traceId:'bench'},async()=>i);
  return performance.now()-start;
 };
 await once(disabled);await once(enabled);
 const baseline=await once(disabled),traced=await once(enabled);
 console.log('[pipeline-trace-overhead] iterations='+iterations+' disabledMs='+baseline.toFixed(3)+' enabledMs='+traced.toFixed(3));
 assert.ok(Number.isFinite(traced)&&Number.isFinite(baseline));
 assert.ok(traced<2000,'Tracing must not add catastrophic synchronous I/O');
 assert.equal(enabled.snapshot().length,iterations*2);
 assert.equal(PIPELINE_STAGES.length>=15,true);
});


test('failed provider receipts are classified even when execution does not throw',async()=>{
 const recorder=new PipelineLatencyRecorder({enabled:true});
 const receipt=await recorder.measure({stage:'browser.operation',origin:'browser',traceId:'action-id'},
  async()=>({ok:false,error:{code:'CDP_COMMAND_TIMEOUT',message:'secret-window-title'}}));
 assert.equal(receipt.ok,false);
 assert.equal(recorder.snapshot()[0]!.result,'timeout');
 assert.doesNotMatch(JSON.stringify(recorder.snapshot()),/secret-window-title|action-id/);
});
