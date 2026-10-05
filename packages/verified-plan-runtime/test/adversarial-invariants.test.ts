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

test('conflicted beliefs cannot authorize mutation commit',()=>{
  const node=graph().nodes[1]!;
  assert.throws(()=>authorizeCommit({
    goalId:'goal-1',node,beliefs:[belief('state.observed','CONFLICTED',.99)]
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

test('completed verification is impossible without node-bound external receipt',()=>{
  const runtime=new VerifiedPlanRuntime(goal(),validatePlanGraph(goal(),graph()));
  assert.throws(()=>runtime.markVerifiedComplete('verify',receipt('verify')),/not awaiting verification/);
});

test('state cannot rehydrate against a different plan version',()=>{
  const runtime=new VerifiedPlanRuntime(goal(),validatePlanGraph(goal(),graph()));
  const state=runtime.exportState();
  const g2=graph(); g2.version=2;
  assert.throws(()=>new VerifiedPlanRuntime(goal(),validatePlanGraph(goal(),g2),state),/different goal\/plan lineage/);
});
