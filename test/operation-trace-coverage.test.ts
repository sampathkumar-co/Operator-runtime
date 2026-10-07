import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateOperationTraceCoverage,
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
  assert.ok(coverage.outOfOrderStages.includes('DISPATCH'));
});
