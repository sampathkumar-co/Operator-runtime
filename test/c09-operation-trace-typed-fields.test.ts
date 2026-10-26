import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTraceEvent, summarizeOperationSlo } from '../src/core/operation-trace.ts';

const valid = () => ({
  schemaVersion: 1, id: 'request-1', traceId: 'c09-typed-input',
  executionContextDigest: 'a'.repeat(64),
  stage: 'REQUEST', outcome: 'OK', durationMs: 25,
  at: '2026-10-25T10:00:00.000Z', attributes: {}
});

test('C09 operation trace normalizes only exact causal digest and duration field types', () => {
  const baseline = normalizeTraceEvent(valid());
  assert.equal(baseline.executionContextDigest,'a'.repeat(64));
  assert.equal(baseline.durationMs,25);
  for(const [field,values] of [
    ['executionContextDigest', [['a'.repeat(64)], {toString:()=> 'a'.repeat(64)}, null, 0]],
    ['durationMs', ['25', [25], true, null, {valueOf:()=>25}, -1, Infinity]],
    ['at', [['2026-10-25T10:00:00.000Z'], {toString:()=> '2026-10-25T10:00:00.000Z'}, null]]
  ] as const) {
    for(const value of values) {
      assert.throws(()=>normalizeTraceEvent({...valid(),[field]:value}),
        (error:any)=>error?.code==='OPERATION_TRACE_INVALID',field+':'+String(typeof value));
    }
  }
});

test('C09 forged type-coerced terminal events cannot produce a verified SLO or latency', () => {
  const request=normalizeTraceEvent(valid());
  const dispatch=normalizeTraceEvent({...valid(),id:'dispatch-1',stage:'DISPATCH',at:'2026-10-25T10:00:00.100Z'});
  const verify=normalizeTraceEvent({...valid(),id:'verify-1',stage:'VERIFY',at:'2026-10-25T10:00:00.150Z'});
  const terminal=normalizeTraceEvent({...valid(),id:'complete-1',stage:'COMPLETE',at:'2026-10-25T10:00:00.200Z'});
  const report=summarizeOperationSlo([request,dispatch,verify,terminal]);
  assert.equal(report.verified,1);
  assert.equal(report.p95CompletionMs,200);
  assert.throws(()=>summarizeOperationSlo([request,dispatch,verify,
    {...terminal,durationMs:'200' as any}]),(error:any)=>error?.code==='OPERATION_TRACE_INVALID');
});

test('C09 normalized audit attributes retain literal prototype-named evidence fields', () => {
  const parsed = JSON.parse('{"__proto__":"must-persist","constructor":"source-tag","ordinary":2}');
  const normalized = normalizeTraceEvent({ ...valid(), attributes: parsed });
  assert.equal(Object.getPrototypeOf(normalized.attributes), Object.prototype);
  assert.equal(Object.hasOwn(normalized.attributes, '__proto__'), true);
  assert.equal(Object.hasOwn(normalized.attributes, 'constructor'), true);
  assert.equal(normalized.attributes['__proto__'], 'must-persist');
  assert.equal(normalized.attributes['constructor'], 'source-tag');
  assert.equal(normalized.attributes.ordinary, 2);
  assert.match(JSON.stringify(normalized), /"__proto__":"must-persist"/);
  assert.deepEqual(normalizeTraceEvent(normalized), normalized);
});
