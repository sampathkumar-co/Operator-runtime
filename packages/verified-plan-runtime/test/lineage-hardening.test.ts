import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VerifiedPlanRuntime, authorizeCommit, createDecisionLineage, digestBeliefs, validateDecisionLineage,
  validatePlanGraph
} from '../src/index.ts';
import { authorityReceipt, belief, D, E, goal, graph, receipt } from './fixtures.ts';

function runtimeThroughAct(){
  const runtime=new VerifiedPlanRuntime(goal(),validatePlanGraph(goal(),graph()));
  runtime.startNode('observe','2026-10-05T10:00:00.000Z');
  runtime.recordExecution('observe',{
    changedFactKeys:['state.observed'],supportedFactKeys:['state.observed'],contradictedFactKeys:[],
    executionOk:true,sideEffectState:'none'
  },'2026-10-05T10:00:01.000Z');
  runtime.bindBeliefs([belief('state.observed')],'2026-10-05T10:00:02.000Z');
  runtime.startNode('act','2026-10-05T10:00:03.000Z');
  const execution=runtime.recordExecution('act',{
    changedFactKeys:['change.applied'],supportedFactKeys:['change.applied'],contradictedFactKeys:[],
    executionOk:true,sideEffectState:'known',evidenceDigests:[E]
  },'2026-10-05T10:00:04.000Z');
  return {runtime,execution};
}

test('completion receipt cannot replay across attempts or executions',()=>{
  const {runtime,execution}=runtimeThroughAct();
  assert.throws(()=>runtime.markVerifiedComplete('act',receipt('act',{
    attempt:2,executionDigest:execution.executionDigest
  })),/different plan\/node\/attempt\/execution lineage/);
  assert.throws(()=>runtime.markVerifiedComplete('act',receipt('act',{
    attempt:1,executionDigest:D
  })),/different plan\/node\/attempt\/execution lineage/);
});

test('persisted plan content cannot change underneath the same id and version',()=>{
  const runtime=new VerifiedPlanRuntime(goal(),validatePlanGraph(goal(),graph()));
  const state=runtime.exportState();
  state.graph.nodes[0]!.expectedCost=999;
  assert.throws(()=>VerifiedPlanRuntime.fromState(state),/digest does not match immutable content/);
});

test('runtime envelope detects payload tampering',()=>{
  const runtime=new VerifiedPlanRuntime(goal(),validatePlanGraph(goal(),graph()));
  const envelope=runtime.exportEnvelope();
  envelope.payload.nodeStates[0]!.status='FAILED';
  assert.throws(()=>VerifiedPlanRuntime.fromEnvelope(envelope),/payload digest mismatch/);
});

test('decision content cannot be edited while retaining an old digest',()=>{
  const runtime=new VerifiedPlanRuntime(goal(),validatePlanGraph(goal(),graph()));
  const decision=createDecisionLineage({
    planId:'plan-1',planVersion:1,planDigest:runtime.planDigest,goalId:'goal-1',nodeId:'observe',
    beliefDigest:digestBeliefs([]),decisionKind:'EXECUTION',decisionId:'dom',
    createdAt:'2026-10-05T10:00:00.000Z'
  });
  decision.decisionId='gui';
  assert.throws(()=>validateDecisionLineage(decision),/digest does not match content/);
  assert.throws(()=>runtime.appendDecision(decision),/digest does not match content/);
});

test('irreversible authorization rejects stale authority snapshots and stale receipts',()=>{
  const node={...graph().nodes.find(n=>n.id==='act')!,reversible:false};
  assert.throws(()=>authorizeCommit({
    goalId:'goal-1',planId:'plan-1',planVersion:1,node,attempt:1,beliefs:[belief('state.observed')],
    authorizationReceipt:authorityReceipt(),currentAuthoritySnapshotDigest:D,now:'2026-10-05T10:01:00.000Z'
  }),/authority snapshot is stale/);
  assert.throws(()=>authorizeCommit({
    goalId:'goal-1',planId:'plan-1',planVersion:1,node,attempt:1,beliefs:[belief('state.observed')],
    authorizationReceipt:authorityReceipt(),currentAuthoritySnapshotDigest:E,now:'2026-10-05T10:10:00.000Z'
  }),/freshness window/);
});

test('accepted verification receipt survives deterministic rehydration',()=>{
  const {runtime,execution}=runtimeThroughAct();
  runtime.markVerifiedComplete('act',receipt('act',{executionDigest:execution.executionDigest}),'2026-10-05T10:00:05.000Z');
  const restored=VerifiedPlanRuntime.fromEnvelope(runtime.exportEnvelope());
  assert.equal(restored.states().find(s=>s.nodeId==='act')?.status,'SUCCEEDED');
  assert.equal(restored.verificationReceipts().length,1);
});
