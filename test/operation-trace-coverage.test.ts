import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateOperationTraceCoverage,
  summarizeOperationSlo,
  type OperationTraceEvent
} from '../src/core/operation-trace.ts';

function e(stage:OperationTraceEvent['stage'],at:string,outcome:OperationTraceEvent['outcome']='OK'):OperationTraceEvent{
  return {
    schemaVersion:1,
    id:'event-'+stage.toLowerCase()+'-'+at.slice(17,23).replace(/[^0-9]/g,''),
    traceId:'trace-coverage-1',
    executionContextDigest:'a'.repeat(64),
    stage,
    outcome,
    at,
    attributes:{}
  };
}

test('trace coverage proves complete ordered high-risk operation lineage',()=>{
  const coverage=evaluateOperationTraceCoverage([
    e('REQUEST','2026-10-07T00:00:00.000Z'),
    e('ROUTE','2026-10-07T00:00:00.100Z'),
    e('PLAN','2026-10-07T00:00:00.200Z'),
    e('POLICY','2026-10-07T00:00:00.300Z'),
    e('APPROVAL','2026-10-07T00:00:00.400Z'),
    e('LEASE','2026-10-07T00:00:00.500Z'),
    e('DISPATCH','2026-10-07T00:00:00.600Z'),
    e('RECONCILE','2026-10-07T00:00:00.700Z'),
    e('VERIFY','2026-10-07T00:00:00.800Z'),
    e('ARTIFACT','2026-10-07T00:00:00.900Z'),
    e('COMPLETE','2026-10-07T00:00:01.000Z')
  ],{
    requiresPlan:true,
    requiresApproval:true,
    requiresLease:true,
    requiresReconciliation:true,
    requiresArtifact:true
  });
  assert.equal(coverage.complete,true);
  assert.deepEqual(coverage.missingStages,[]);
  assert.deepEqual(coverage.outOfOrderStages,[]);
});

test('trace coverage refuses success missing approval verification or artifact lineage',()=>{
  const coverage=evaluateOperationTraceCoverage([
    e('REQUEST','2026-10-07T00:00:00.000Z'),
    e('ROUTE','2026-10-07T00:00:00.100Z'),
    e('POLICY','2026-10-07T00:00:00.200Z'),
    e('DISPATCH','2026-10-07T00:00:00.300Z'),
    e('COMPLETE','2026-10-07T00:00:00.400Z')
  ],{requiresApproval:true,requiresArtifact:true});
  assert.equal(coverage.complete,false);
  assert.ok(coverage.missingStages.includes('APPROVAL'));
  assert.ok(coverage.missingStages.includes('VERIFY'));
  assert.ok(coverage.missingStages.includes('ARTIFACT'));
});

test('trace coverage detects required stages that occur out of causal order',()=>{
  const coverage=evaluateOperationTraceCoverage([
    e('REQUEST','2026-10-07T00:00:00.000Z'),
    e('ROUTE','2026-10-07T00:00:00.100Z'),
    e('POLICY','2026-10-07T00:00:00.200Z'),
    e('VERIFY','2026-10-07T00:00:00.300Z'),
    e('DISPATCH','2026-10-07T00:00:00.400Z'),
    e('COMPLETE','2026-10-07T00:00:00.500Z')
  ]);
  assert.equal(coverage.complete,false);
  assert.ok(coverage.outOfOrderStages.includes('VERIFY'));
});

test('C09 operation SLO rejects verification that occurs after an already claimed completion',()=>{
  const trace=[
    e('REQUEST','2026-10-07T00:00:00.000Z'),
    e('ROUTE','2026-10-07T00:00:00.100Z'),
    e('POLICY','2026-10-07T00:00:00.200Z'),
    e('DISPATCH','2026-10-07T00:00:00.300Z'),
    e('COMPLETE','2026-10-07T00:00:00.400Z'),
    e('VERIFY','2026-10-07T00:00:00.500Z')
  ];
  const report=summarizeOperationSlo(trace);
  assert.equal(report.completed,1);
  assert.equal(report.verified,0);
  assert.equal(report.falseCompletionCount,1);
});

test('C09 operation SLO preserves verified claim only when last verification precedes completion',()=>{
  const valid=[
    e('REQUEST','2026-10-07T00:00:00.000Z'),
    e('DISPATCH','2026-10-07T00:00:00.050Z'),
    e('VERIFY','2026-10-07T00:00:00.100Z'),
    e('COMPLETE','2026-10-07T00:00:00.200Z')
  ];
  const good=summarizeOperationSlo(valid);
  assert.equal(good.verified,1);
  assert.equal(good.falseCompletionCount,0);
  const stale=[...valid,e('VERIFY','2026-10-07T00:00:00.300Z','FAILED')];
  const bad=summarizeOperationSlo(stale);
  assert.equal(bad.verified,0);
  assert.equal(bad.falseCompletionCount,1);
});

test('C09 a failed terminal outcome must not be counted as verified task success',()=>{
  const report=summarizeOperationSlo([
    e('REQUEST','2026-10-07T00:00:00.000Z'),
    e('VERIFY','2026-10-07T00:00:00.100Z'),
    e('COMPLETE','2026-10-07T00:00:00.200Z','FAILED')
  ]);
  assert.equal(report.completed,0);
  assert.equal(report.verified,0);
  assert.equal(report.falseCompletionCount,0);
  assert.equal(report.failed,1);
});

test('C09 stale verifier before the latest dispatch never grants terminal SLO success', () => {
  const trace = [
    e('REQUEST','2026-10-07T00:00:00.000Z'),
    e('DISPATCH','2026-10-07T00:00:00.100Z'),
    e('VERIFY','2026-10-07T00:00:00.200Z'),
    e('DISPATCH','2026-10-07T00:00:00.300Z'),
    e('COMPLETE','2026-10-07T00:00:00.400Z')
  ];
  const stale = summarizeOperationSlo(trace);
  assert.equal(stale.completed, 1);
  assert.equal(stale.verified, 0);
  assert.equal(stale.falseCompletionCount, 1);
  trace.splice(4, 0, e('VERIFY','2026-10-07T00:00:00.350Z'));
  const fresh = summarizeOperationSlo(trace);
  assert.equal(fresh.verified, 1);
  assert.equal(fresh.falseCompletionCount, 0);
});

test('C09 identical-timestamp dispatch and verification cannot prove causal ordering', () => {
  const report = summarizeOperationSlo([
    e('REQUEST','2026-10-07T00:00:00.000Z'),
    e('DISPATCH','2026-10-07T00:00:00.100Z'),
    e('VERIFY','2026-10-07T00:00:00.100Z'),
    e('COMPLETE','2026-10-07T00:00:00.200Z')
  ]);
  assert.equal(report.verified, 0);
  assert.equal(report.falseCompletionCount, 1);
});

test('C09 coverage cannot use stale verifier after a later side effect to claim COMPLETE', () => {
  const trace = [
    e('REQUEST','2026-10-25T00:00:00.000Z'),
    e('ROUTE','2026-10-25T00:00:00.100Z'),
    e('POLICY','2026-10-25T00:00:00.200Z'),
    e('DISPATCH','2026-10-25T00:00:00.300Z'),
    e('VERIFY','2026-10-25T00:00:00.400Z'),
    e('DISPATCH','2026-10-25T00:00:00.500Z'),
    e('COMPLETE','2026-10-25T00:00:00.700Z')
  ];
  const stale = evaluateOperationTraceCoverage(trace);
  assert.equal(stale.complete, false);
  assert.ok(stale.outOfOrderStages.includes('VERIFY'));
  assert.equal(summarizeOperationSlo(trace).falseCompletionCount, 1);
  const fresh = [
    ...trace.slice(0, -1),
    e('VERIFY','2026-10-25T00:00:00.600Z'),
    trace.at(-1)!
  ];
  assert.equal(evaluateOperationTraceCoverage(fresh).complete, true);
  assert.equal(summarizeOperationSlo(fresh).falseCompletionCount, 0);
});

test('C09 successful trace completion requires latest verifier to be OK and strictly earlier', () => {
  const ordered = [
    e('REQUEST','2026-10-25T00:00:00.000Z'),
    e('ROUTE','2026-10-25T00:00:00.100Z'),
    e('POLICY','2026-10-25T00:00:00.200Z'),
    e('DISPATCH','2026-10-25T00:00:00.300Z'),
    e('VERIFY','2026-10-25T00:00:00.400Z'),
    e('COMPLETE','2026-10-25T00:00:00.500Z')
  ];
  assert.equal(evaluateOperationTraceCoverage(ordered).complete, true);
  const failedProof = [...ordered.slice(0, -1),
    e('VERIFY','2026-10-25T00:00:00.450Z','FAILED'), ordered.at(-1)!];
  assert.equal(evaluateOperationTraceCoverage(failedProof).complete, false);
  const simultaneous = [
    ...ordered.slice(0, -1),
    e('COMPLETE','2026-10-25T00:00:00.400Z')
  ];
  assert.equal(evaluateOperationTraceCoverage(simultaneous).complete, false);
});

test('C09 100 exact synthetic traces expose p50, p95 and p99 completion tails without inventing measurements', () => {
  const rows: OperationTraceEvent[] = [];
  const baseline = Date.parse('2026-10-25T00:00:00.000Z');
  for (let i = 0; i < 100; i++) {
    const started = baseline + i * 1_000;
    const duration = i + 1;
    const traceId = 'trace-percentile-' + i;
    rows.push({
      ...e('REQUEST', new Date(started).toISOString()),
      id: 'request-' + i, traceId
    });
    rows.push({
      ...e('COMPLETE', new Date(started + duration).toISOString()),
      id: 'complete-' + i, traceId
    });
  }
  const summary = summarizeOperationSlo(rows);
  assert.equal(summary.traces, 100);
  assert.equal(summary.completed, 100);
  assert.equal(summary.p50CompletionMs, 50);
  assert.equal(summary.p95CompletionMs, 95);
  assert.equal(summary.p99CompletionMs, 99);
});

test('C09 empty operation sample exposes zero p99 rather than fabricated latency', () => {
  const empty = summarizeOperationSlo([]);
  assert.equal(empty.traces, 0);
  assert.equal(empty.p50CompletionMs, 0);
  assert.equal(empty.p95CompletionMs, 0);
  assert.equal(empty.p99CompletionMs, 0);
});

test('C09 cross-context terminal claims do not count as verified success or latency samples', () => {
  const valid = [
    e('REQUEST', '2026-10-25T00:00:00.000Z'),
    e('DISPATCH', '2026-10-25T00:00:00.050Z'),
    e('VERIFY', '2026-10-25T00:00:00.100Z'),
    e('COMPLETE', '2026-10-25T00:00:00.200Z')
  ];
  const good = summarizeOperationSlo(valid);
  assert.equal(good.verified, 1);
  assert.equal(good.invalidCausalTraces, 0);
  assert.equal(good.p95CompletionMs, 200);

  const mixed = [valid[0]!, valid[1]!, {...valid[2]!, executionContextDigest:'b'.repeat(64)}, valid[3]!];
  const report = summarizeOperationSlo(mixed);
  assert.equal(report.traces, 1);
  assert.equal(report.completed, 1, 'raw terminal claims remain visible for safety accounting');
  assert.equal(report.verified, 0);
  assert.equal(report.falseCompletionCount, 1);
  assert.equal(report.invalidCausalTraces, 1);
  assert.equal(report.p95CompletionMs, 0, 'no invalid measurement enters a percentile');
});

test('C09 duplicate terminal claims and event identities fail closed in operation SLOs', () => {
  const base = [
    e('REQUEST', '2026-10-25T00:00:00.000Z'),
    e('DISPATCH', '2026-10-25T00:00:00.050Z'),
    e('VERIFY', '2026-10-25T00:00:00.100Z'),
    e('COMPLETE', '2026-10-25T00:00:00.200Z')
  ];
  for (const mutated of [
    [...base, e('COMPLETE', '2026-10-25T00:00:00.300Z')],
    [...base, {...base[2]!, id:base[0]!.id}],
    [base[0]!, base[1]!, base[3]!, e('VERIFY', '2026-10-25T00:00:00.300Z')],
    [base[1]!, base[2]!, base[3]!],
    [...base, {...base[0]!, id:'replayed-request',at:'2026-10-25T00:00:00.300Z'}]
  ]) {
    const report = summarizeOperationSlo(mutated);
    assert.equal(report.verified, 0);
    assert.equal(report.invalidCausalTraces, 1);
    assert.equal(report.p95CompletionMs, 0);
    assert.equal(report.falseCompletionCount, 1);
  }
});

test('C09 completed and incomplete traces never fabricate samples from absent requests', () => {
  const report = summarizeOperationSlo([
    e('VERIFY', '2026-10-25T00:00:00.100Z'),
    e('COMPLETE', '2026-10-25T00:00:00.200Z')
  ]);
  assert.equal(report.completed, 1);
  assert.equal(report.verified, 0);
  assert.equal(report.falseCompletionCount, 1);
  assert.equal(report.p50CompletionMs, 0);
  assert.equal(report.invalidCausalTraces, 1);
});

test('C09 active operation traces remain incomplete, not corrupt terminal evidence', () => {
  const report = summarizeOperationSlo([
    e('REQUEST', '2026-10-25T00:00:00.000Z'),
    e('DISPATCH', '2026-10-25T00:00:00.100Z')
  ]);
  assert.equal(report.traces, 1);
  assert.equal(report.incompleteTraces, 1);
  assert.equal(report.invalidCausalTraces, 0);
  assert.equal(report.completed, 0);
  assert.equal(report.p95CompletionMs, 0);
});

test('C09 a VERIFIED terminal without any dispatched provider work is unproven', () => {
  const report = summarizeOperationSlo([
    e('REQUEST','2026-10-25T01:00:00.000Z'),
    e('VERIFY','2026-10-25T01:00:00.100Z'),
    e('COMPLETE','2026-10-25T01:00:00.200Z')
  ]);
  assert.equal(report.completed, 1);
  assert.equal(report.verified, 0);
  assert.equal(report.falseCompletionCount, 1);
  assert.equal(report.invalidCausalTraces, 0, 'lineage can be intact while outcome remains unverified');
});

test('C09 source-shifted and duplicate terminal trace events cannot pass coverage', () => {
  const canonical = [
    e('REQUEST','2026-10-25T01:00:00.000Z'),
    e('ROUTE','2026-10-25T01:00:00.100Z'),
    e('POLICY','2026-10-25T01:00:00.200Z'),
    e('DISPATCH','2026-10-25T01:00:00.300Z'),
    e('VERIFY','2026-10-25T01:00:00.400Z'),
    e('COMPLETE','2026-10-25T01:00:00.500Z')
  ];
  assert.equal(evaluateOperationTraceCoverage(canonical).invalidCausalTrace, false);
  assert.equal(evaluateOperationTraceCoverage(canonical).complete, true);
  const malformed = [
    [...canonical.slice(0, -1), {...canonical.at(-1)!, executionContextDigest:'b'.repeat(64)}],
    [...canonical, {...canonical.at(-1)!, id:'extra-complete',at:'2026-10-25T01:00:00.600Z'}],
    [...canonical, {...canonical[1]!, id:'extra-route',at:'2026-10-25T01:00:00.700Z'}],
    [...canonical, {...canonical[2]!, id:canonical[1]!.id}]
  ];
  for (const trace of malformed) {
    const result = evaluateOperationTraceCoverage(trace);
    assert.equal(result.complete, false);
    assert.equal(result.invalidCausalTrace, true);
  }
});
