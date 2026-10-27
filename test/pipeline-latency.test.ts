import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PipelineLatencyRecorder, opaqueTraceId, PIPELINE_STAGES
} from '../src/core/pipeline-latency.ts';

test('C11 pipeline tracing is inert by default and cannot change action results', async () => {
  const recorder = new PipelineLatencyRecorder();
  const value = await recorder.measure({
    stage: 'browser.operation', origin: 'browser', traceId: 'private-task-identifier'
  }, async () => 42);
  assert.equal(value, 42);
  assert.deepEqual(recorder.snapshot(), []);
  assert.deepEqual(recorder.summarize(), []);
  assert.equal(recorder.droppedSpans, 0);
});

test('C11 explicit opt-in yields opaque stable trace and nested parent-child relation', async () => {
  const recorder = new PipelineLatencyRecorder({ enabled: true, capacity: 6 });
  const label = 'SENSITIVE_ACTION_ID_SHOULD_NOT_BE_RETAINED';
  const result = await recorder.measure({ stage: 'browser.operation', origin: 'browser', traceId: label },
    async () => await recorder.measure({stage:'browser.cdp_roundtrip', origin:'browser'}, ()=> 'ok'));
  assert.equal(result,'ok');
  const spans = recorder.snapshot();
  assert.equal(spans.length,2);
  const parent = spans.find(x=>x.stage==='browser.operation')!;
  const child = spans.find(x=>x.stage==='browser.cdp_roundtrip')!;
  assert.equal(parent.traceId,opaqueTraceId(label));
  assert.equal(child.traceId,parent.traceId);
  assert.equal(child.parentSpanId,parent.spanId);
  assert.notEqual(parent.traceId,label);
  assert.equal(JSON.stringify(spans).includes(label),false);
  assert.ok(spans.every(x=>Number.isFinite(x.durationMs) && x.durationMs>=0 && x.result==='ok'));
});

test('C11 bounded ring discards older spans without unbounded growth', async () => {
  const recorder = new PipelineLatencyRecorder({ enabled: true,capacity:3 });
  for(let i=0;i<8;i++) {
    await recorder.measure({stage:'relay.queue_wait',origin:'relay-server',traceId:String(i)},()=>i);
  }
  assert.equal(recorder.snapshot().length,3);
  assert.equal(recorder.droppedSpans,5);
  assert.equal(recorder.summarize()[0]!.count,3);
});

test('C11 captured errors are not persisted in telemetry, and are rethrown exactly', async () => {
  const recorder=new PipelineLatencyRecorder({enabled:true});
  const original=new Error('SENSITIVE_EXTERNAL_CREDENTIAL_IN_ERROR');
  await assert.rejects(recorder.measure({stage:'relay.result_wait',origin:'relay-server'},()=>{
    throw original;
  }),(error:any)=>error===original);
  const [span]=recorder.snapshot();
  assert.equal(span?.result,'failed');
  assert.equal(JSON.stringify(span).includes('SENSITIVE'),false);
});

test('C11 per-stage quantiles are integer-rank and type-safe, no raw provider fields', async () => {
  const recorder=new PipelineLatencyRecorder({enabled:true,capacity:40});
  for(let i=0;i<30;i++) await recorder.measure({
    stage:'browser.operation',origin:'browser',traceId:'opaque-synthetic'
  },()=>i);
  const [entry]=recorder.summarize();
  assert.equal(entry?.stage,'browser.operation');
  assert.equal(entry?.count,30);
  assert.ok((entry?.p50Ms ?? -1)>=0);
  assert.ok((entry?.p95Ms ?? -1)>=(entry?.p50Ms ?? 0));
  assert.ok((entry?.maxMs ?? -1)>=(entry?.p95Ms ?? 0));
  assert.ok(PIPELINE_STAGES.includes('relay.result_wait'));
});

test('C11 malformed capacity, stage and trace inputs fail closed', async () => {
  for(const bad of [0,-1,1.5,8193,Infinity,Number.NaN]) {
    assert.throws(()=>new PipelineLatencyRecorder({enabled:true,capacity:bad}));
  }
  const recorder=new PipelineLatencyRecorder({enabled:true});
  await assert.rejects(()=>recorder.measure({stage:'SENSITIVE_SECRET_PATH' as any,origin:'browser'},()=>0));
  await assert.rejects(()=>recorder.measure({stage:'browser.operation',origin:'UNSAFE_ORIGIN' as any},()=>0));
  assert.throws(()=>opaqueTraceId(''));
  assert.throws(()=>opaqueTraceId('x'.repeat(600)));
  assert.deepEqual(recorder.snapshot(),[]);
});
