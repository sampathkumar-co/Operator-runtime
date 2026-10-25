import assert from 'node:assert/strict';
import test from 'node:test';
import type { OperationTraceEvent, OperationTraceStage } from '../src/core/operation-trace.ts';
import { summarizeOperationStageLatency } from '../src/core/operation-stage-latency.ts';

function event(traceId: string, stage: OperationTraceStage, ms: number, suffix = ''): OperationTraceEvent {
  return {
    schemaVersion: 1,
    id: 'event-' + stage.toLowerCase() + '-' + ms + suffix,
    traceId,
    executionContextDigest: 'a'.repeat(64),
    stage,
    outcome: 'OK',
    at: new Date(Date.UTC(2026, 9, 25) + ms).toISOString(),
    attributes: {}
  };
}

test('C09 reports p50/p95/p99 end-to-end and inter-stage latency from actual bounded events', () => {
  const events: OperationTraceEvent[] = [];
  for (let i=1; i<=100; i++) {
    const offset = i * 5_000;
    events.push(event('trace-' + i, 'REQUEST', offset));
    events.push(event('trace-' + i, 'POLICY', offset + i));
    events.push(event('trace-' + i, 'DISPATCH', offset + i*2));
    events.push(event('trace-' + i, 'VERIFY', offset + i*3));
    events.push(event('trace-' + i, 'COMPLETE', offset + i*4));
  }
  const report = summarizeOperationStageLatency(events.reverse());
  assert.equal(report.traces, 100);
  assert.equal(report.terminalTraces, 100);
  assert.equal(report.incompleteTraces, 0);
  assert.equal(report.invalidCausalTraces, 0);
  assert.equal(report.p50EndToEndMs, 200);
  assert.equal(report.p95EndToEndMs, 380);
  assert.equal(report.p99EndToEndMs, 396);
  assert.equal(report.stages.find(x=>x.stage==='DISPATCH')?.p99Ms, 99);
  assert.equal(report.stages.find(x=>x.stage==='VERIFY')?.maxMs, 100);
});

test('C09 incomplete traces never silently enter completion percentile denominator', () => {
  const rows = [event('complete','REQUEST',0), event('complete','COMPLETE',10),
    event('waiting','REQUEST',20), event('waiting','DISPATCH',30)];
  const report = summarizeOperationStageLatency(rows);
  assert.equal(report.traces, 2);
  assert.equal(report.terminalTraces, 1);
  assert.equal(report.incompleteTraces, 1);
  assert.equal(report.p95EndToEndMs, 10);
});

test('C09 duplicate terminal, scope-shift, or post-completion evidence cannot inflate latency samples', () => {
  const duplicates = [event('duplicate','REQUEST',0),event('duplicate','COMPLETE',10),
    event('duplicate','COMPLETE',12,'b')];
  const wrongContext = [event('shift','REQUEST',20), {
    ...event('shift','COMPLETE',25), executionContextDigest:'b'.repeat(64)
  }];
  const postComplete = [event('late','REQUEST',30),event('late','COMPLETE',40),
    event('late','DISPATCH',45)];
  const report = summarizeOperationStageLatency([...duplicates,...wrongContext,...postComplete]);
  assert.equal(report.terminalTraces,0);
  assert.equal(report.invalidCausalTraces,3);
  assert.equal(report.p99EndToEndMs,0);
});

test('C09 bound excessive trace input and reject untrusted event structure', () => {
  assert.throws(()=>summarizeOperationStageLatency(Array(100_001).fill(event('x','REQUEST',0))),
    (error:any)=>error?.code==='OPERATION_LATENCY_INVALID');
  assert.throws(()=>summarizeOperationStageLatency([{...event('x','REQUEST',0),durationMs:-1}]),
    (error:any)=>error?.code==='OPERATION_TRACE_INVALID');
});

test('C09 stage latency refuses replayed event IDs even with an otherwise valid context', () => {
  const baseline = [
    event('event-replay','REQUEST',0),
    event('event-replay','DISPATCH',10),
    event('event-replay','VERIFY',20),
    event('event-replay','COMPLETE',30)
  ];
  assert.equal(summarizeOperationStageLatency(baseline).terminalTraces,1);
  for (const forged of [
    [...baseline.slice(0,3), {...baseline[3]!,id:baseline[1]!.id}],
    [...baseline.slice(0,2), {...baseline[2]!,id:baseline[0]!.id},baseline[3]!]
  ]) {
    const report=summarizeOperationStageLatency(forged);
    assert.equal(report.invalidCausalTraces,1);
    assert.equal(report.terminalTraces,0);
    assert.equal(report.p95EndToEndMs,0);
    assert.equal(report.stages.length,0);
  }
});
