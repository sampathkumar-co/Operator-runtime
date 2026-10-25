import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeOperationStageLatency } from '../src/core/operation-stage-latency.ts';

function row(traceId, stage, ms) {
  return {
    schemaVersion: 1, id: traceId + '-' + stage + '-' + ms,
    traceId, executionContextDigest: 'a'.repeat(64), stage, outcome: 'OK',
    at: new Date(Date.UTC(2026, 9, 25) + ms).toISOString(), attributes: {}
  };
}
test('C09 no completed trace remains explicitly not measured, not a fictional zero latency', () => {
  const empty = summarizeOperationStageLatency([]);
  assert.equal(empty.terminalTraces, 0);
  assert.equal(empty.endToEndMeasurement, 'NOT_OBSERVED');
  const pending = summarizeOperationStageLatency([
    row('t1','REQUEST',0), row('t1','DISPATCH',10)
  ]);
  assert.equal(pending.incompleteTraces, 1);
  assert.equal(pending.terminalTraces, 0);
  assert.equal(pending.endToEndMeasurement, 'NOT_OBSERVED');
});
test('C09 completed zero-millisecond trace is a genuine measurement and stays distinct from missing', () => {
  const actual = summarizeOperationStageLatency([
    row('t1','REQUEST',0), row('t1','COMPLETE',0)
  ]);
  assert.equal(actual.terminalTraces, 1);
  assert.equal(actual.endToEndMeasurement, 'MEASURED');
  assert.equal(actual.p50EndToEndMs, 0);
});
