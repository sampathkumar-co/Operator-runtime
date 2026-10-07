import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VerifiedPlanRuntime, assessInfeasibility, authorizeCommit, createDecisionLineage,
  digestBeliefs, validatePlanGraph
} from '../src/index.ts';
import { authorityReceipt, belief, E, goal, graph, receipt } from './fixtures.ts';

test('irreversible actions require fresh authority receipt and explicit verification facts',()=>{
  const node={...graph().nodes[1]!,reversible:false};
  assert.throws(()=>authorizeCommit({
    goalId:'goal-1',planId:'plan-1',planVersion:1,node,attempt:1,
    beliefs:[belief('state.observed')],now:'2026-10-05T10:01:00.000Z'
  }),/authorization receipt/);
  const permit=authorizeCommit({
    goalId:'goal-1',planId:'plan-1',planVersion:1,node,attempt:1,
    beliefs:[belief('state.observed')],authorizationReceipt:authorityReceipt(),
    currentAuthoritySnapshotDigest:E,now:'2026-10-05T10:01:00.000Z'
  });
  assert.match(permit.digest,/^[0-9a-f]{64}$/);
  assert.equal(permit.nodeId,'act');
  assert.equal(permit.attempt,1);
});

test('receipt replay across nodes is rejected and exact execution is accepted',()=>{
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
    executionOk:true,sideEffectState:'known'
  },'2026-10-05T10:00:04.000Z');
  assert.throws(
    ()=>runtime.markVerifiedComplete('act',receipt('verify',{executionDigest:execution.executionDigest})),
    /different plan\/node\/attempt\/execution lineage/
  );
  assert.equal(
    runtime.markVerifiedComplete('act',receipt('act',{executionDigest:execution.executionDigest}),'2026-10-05T10:00:05.000Z').status,
    'SUCCEEDED'
  );
});

test('runtime repairs locally and preserves prior succeeded work',()=>{
  const runtime=new VerifiedPlanRuntime(goal(),validatePlanGraph(goal(),graph()));
  runtime.startNode('observe');
  runtime.recordExecution('observe',{
    changedFactKeys:['state.observed'],supportedFactKeys:['state.observed'],contradictedFactKeys:[],
    executionOk:true,sideEffectState:'none'
  });
  runtime.bindBeliefs([belief('state.observed')]);
  runtime.startNode('act');
  const result=runtime.recordExecution('act',{
    changedFactKeys:[],supportedFactKeys:[],contradictedFactKeys:[],
    executionOk:true,sideEffectState:'known'
  });
  assert.equal(result.state.status,'FAILED');
  assert.deepEqual(result.repair?.preservedSucceededNodeIds,['observe']);
  assert.deepEqual(result.repair?.invalidatedNodeIds,['act','verify']);
});

test('runtime state rehydrates deterministically',()=>{
  const runtime=new VerifiedPlanRuntime(goal(),validatePlanGraph(goal(),graph()));
  const before=runtime.stateDigest();
  const restored=VerifiedPlanRuntime.fromState(runtime.exportState());
  assert.equal(restored.stateDigest(),before);
});

test('decision lineage binds immutable plan content, node and belief digest',()=>{
  const runtime=new VerifiedPlanRuntime(goal(),validatePlanGraph(goal(),graph()));
  const beliefs=[belief('state.observed')];
  const line=createDecisionLineage({
    planId:'plan-1',planVersion:1,planDigest:runtime.planDigest,goalId:'goal-1',nodeId:'observe',
    beliefDigest:digestBeliefs(beliefs),decisionKind:'EXECUTION',decisionId:'pw',
    createdAt:'2026-10-05T10:00:00.000Z'
  });
  const changed=createDecisionLineage({
    planId:'plan-1',planVersion:1,planDigest:runtime.planDigest,goalId:'goal-1',nodeId:'act',
    beliefDigest:digestBeliefs(beliefs),decisionKind:'EXECUTION',decisionId:'pw',
    createdAt:'2026-10-05T10:00:00.000Z'
  });
  assert.notEqual(line.digest,changed.digest);
  runtime.appendDecision(line);
  assert.equal(runtime.decisions().length,1);
});

test('infeasibility requires evidence and distinguishes unresolved from impossible',()=>{
  const p=validatePlanGraph(goal(),graph());
  const runtime=new VerifiedPlanRuntime(goal(),p);
  const unresolved=assessInfeasibility({goal:goal(),graph:p,states:runtime.states(),availableCapabilities:['browser.read','browser.write']});
  assert.equal(unresolved.terminal,false);
  assert.equal(unresolved.class,'INSUFFICIENT_EVIDENCE');

  const impossible=assessInfeasibility({goal:goal(),graph:p,states:runtime.states(),availableCapabilities:[],searchExhausted:true});
  assert.equal(impossible.terminal,true);
  assert.equal(impossible.class,'CAPABILITY_MISSING');
});
