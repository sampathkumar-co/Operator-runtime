import assert from 'node:assert/strict';
import test from 'node:test';
import { CausalGraph, assessProgress } from '../src/index.ts';
import type { BeliefResolution, GoalDescriptor } from '../src/index.ts';

const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';

function setup(){
  const graph=new CausalGraph({clock:()=>new Date(T0)});
  const transition=graph.record({
    before:{
      id:'before',observedAt:T0,scopeKey:'scene',
      facts:[{key:'goal.done',valueDigest:B,confidence:1,evidence:[]}]
    },
    action:{
      id:'action',family:'semantic',capability:'ui.interact',risk:'write',
      expectedEffects:['goal.done']
    },
    outcome:{ok:true,sideEffectState:'known',executionPhase:'effect_observed',evidence:[]},
    after:{
      id:'after',observedAt:T0,scopeKey:'scene',
      facts:[{key:'goal.done',valueDigest:A,confidence:1,evidence:[]}]
    },
    progressSignals:['done']
  });
  const beliefs:BeliefResolution[]=[{
    factKey:'goal.done',
    status:'KNOWN',
    confidence:0.99,
    selectedValueDigest:A,
    supportingEvidence:[{digest:A,source:'verifier-read',observedAt:T0}],
    contradictingEvidence:[],
    staleEvidence:[],
    alternatives:[{valueDigest:A,confidence:0.99}],
    updatedAt:T0
  }];
  const goal:GoalDescriptor={id:'goal-1',kind:'synthetic',objective:'finish',successFactKeys:['goal.done']};
  return{transition,beliefs,goal};
}

test('legacy bare independentVerification boolean cannot mark goal achieved',()=>{
  const {transition,beliefs,goal}=setup();
  const result=assessProgress({
    goal,
    transition,
    beliefs,
    independentVerification:true
  } as any);
  assert.equal(result.level,'SUBGOAL_PROGRESS');
  assert.equal(result.verificationRequired,true);
});

test('goal-bound verification receipt permits verified completion',()=>{
  const {transition,beliefs,goal}=setup();
  const result=assessProgress({
    goal,
    transition,
    beliefs,
    verificationReceipt:{
      digest:C,
      goalId:'goal-1',
      verifierId:'verification-kernel',
      verifiedAt:T0,
      authoritySnapshotDigest:B
    }
  });
  assert.equal(result.level,'GOAL_ACHIEVED');
  assert.equal(result.verificationRequired,false);
});

test('verification receipt bound to another goal is rejected fail closed',()=>{
  const {transition,beliefs,goal}=setup();
  assert.throws(()=>assessProgress({
    goal,
    transition,
    beliefs,
    verificationReceipt:{
      digest:C,
      goalId:'different-goal',
      verifierId:'verification-kernel',
      verifiedAt:T0,
      authoritySnapshotDigest:B
    }
  }),/bound to a different goal/);
});

test('verification receipt requires cryptographic digest-shaped references',()=>{
  const {transition,beliefs,goal}=setup();
  assert.throws(()=>assessProgress({
    goal,
    transition,
    beliefs,
    verificationReceipt:{
      digest:'not-a-digest',
      goalId:'goal-1',
      verifierId:'verification-kernel',
      verifiedAt:T0,
      authoritySnapshotDigest:B
    }
  }),/must be SHA-256/);
});
