import test from 'node:test';
import assert from 'node:assert/strict';
import { VerifiedPlanRuntime, authorizeCommit, bindPlanToBeliefs, initializeNodeStates, validatePlanGraph } from '../src/index.ts';
import { belief, goal, graph, receipt } from './fixtures.ts';

test('stale beliefs do not satisfy preconditions unless node explicitly opts in',()=>{
  const p=validatePlanGraph(goal(),graph());
  const states=initializeNodeStates(p);
  states[0]!.status='SUCCEEDED';
  const out=bindPlanToBeliefs(p,states,[belief('state.observed','STALE',.9)]);
  assert.equal(out.readyNodeIds.includes('act'),false);
});

test('conflicted belief blocks execution but does not permanently invalidate the plan',()=>{
  const p=validatePlanGraph(goal(),graph());
  const states=initializeNodeStates(p);
  states[0]!.status='SUCCEEDED';
  states[1]!.status='READY';
  const out=bindPlanToBeliefs(p,states,[belief('state.observed','CONFLICTED',.99)]);
  assert.deepEqual(out.invalidatedNodeIds,[]);
  assert.equal(out.states.find(s=>s.nodeId==='act')?.status,'BLOCKED');
});

test('conflicted beliefs cannot authorize mutation commit',()=>{
  const node=graph().nodes[1]!;
  assert.throws(()=>authorizeCommit({
    goalId:'goal-1',planId:'plan-1',planVersion:1,node,attempt:1,
    beliefs:[belief('state.observed','CONFLICTED',.99)]
  }),/unverified precondition/);
});

test('uncertain side effects force failure/repair rather than mutation replay',()=>{
  const runtime=new VerifiedPlanRuntime(goal(),validatePlanGraph(goal(),graph()));
  runtime.startNode('observe');
  const result=runtime.recordExecution('observe',{
    changedFactKeys:[],supportedFactKeys:[],contradictedFactKeys:[],
    executionOk:true,sideEffectState:'uncertain'
  });
  assert.equal(result.state.status,'FAILED');
  assert.match(result.state.lastReason??'',/uncertain/);
});

test('completed verification is impossible without an executed node awaiting verification',()=>{
  const runtime=new VerifiedPlanRuntime(goal(),validatePlanGraph(goal(),graph()));
  assert.throws(()=>runtime.markVerifiedComplete('verify',receipt('verify')),/not awaiting verification/);
});

test('state cannot rehydrate against a different plan version',()=>{
  const runtime=new VerifiedPlanRuntime(goal(),validatePlanGraph(goal(),graph()));
  const state=runtime.exportState();
  const g2=graph(); g2.version=2;
  assert.throws(()=>new VerifiedPlanRuntime(goal(),validatePlanGraph(goal(),g2),state),/different goal\/plan lineage/);
});

test('belief refresh cannot reopen an executed mutation awaiting verification',()=>{
  const runtime=new VerifiedPlanRuntime(goal(),validatePlanGraph(goal(),graph()));
  runtime.startNode('observe','2026-10-05T10:00:00.000Z');
  runtime.recordExecution('observe',{
    changedFactKeys:['state.observed'],supportedFactKeys:['state.observed'],contradictedFactKeys:[],
    executionOk:true,sideEffectState:'none'
  },'2026-10-05T10:00:01.000Z');
  runtime.bindBeliefs([belief('state.observed')],'2026-10-05T10:00:02.000Z');
  runtime.startNode('act','2026-10-05T10:00:03.000Z');
  runtime.recordExecution('act',{
    changedFactKeys:['change.applied'],supportedFactKeys:['change.applied'],contradictedFactKeys:[],
    executionOk:true,sideEffectState:'known'
  },'2026-10-05T10:00:04.000Z');
  assert.equal(runtime.states().find(s=>s.nodeId==='act')?.status,'BLOCKED');
  runtime.bindBeliefs([belief('state.observed')],'2026-10-05T10:00:05.000Z');
  assert.equal(runtime.states().find(s=>s.nodeId==='act')?.status,'BLOCKED');
});

test('belief rebinding is forbidden while an execution is running',()=>{
  const runtime=new VerifiedPlanRuntime(goal(),validatePlanGraph(goal(),graph()));
  runtime.startNode('observe');
  assert.throws(()=>runtime.bindBeliefs([]),/forbidden while an execution node is running/);
});
