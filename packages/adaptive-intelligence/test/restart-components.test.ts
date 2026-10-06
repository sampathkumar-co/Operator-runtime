import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CalibrationTracker,
  CausalGraph,
  EpistemicStateEngine,
  LearningFirewall
} from '../src/index.ts';
import type {
  LearningVerificationReceiptRef,
  SkillDraft
} from '../src/index.ts';

const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),D='d'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';

test('epistemic raw claim state round-trips without losing conflict or independence provenance',()=>{
  const one=new EpistemicStateEngine({clock:()=>new Date(T0)});
  one.observe({
    factKey:'target.identity',
    valueDigest:A,
    polarity:'supports',
    confidence:0.8,
    evidence:{
      digest:B,
      source:'dom',
      channel:'dom',
      observedAt:T0,
      independenceKey:'dom-snapshot-1'
    }
  });
  one.observe({
    factKey:'target.identity',
    valueDigest:C,
    polarity:'supports',
    confidence:0.8,
    evidence:{
      digest:D,
      source:'uia',
      channel:'uia',
      observedAt:T0,
      independenceKey:'uia-snapshot-1'
    }
  });
  one.markUnobservable('target.geometry');

  const state=one.exportState();
  const two=EpistemicStateEngine.fromState(state,{clock:()=>new Date(T0)});
  assert.deepEqual(two.exportState(),state);
  assert.deepEqual(two.resolve('target.identity'),one.resolve('target.identity'));
  assert.equal(two.resolve('target.geometry').status,'UNOBSERVABLE');
});

test('epistemic restore rejects duplicate persisted claims',()=>{
  const one=new EpistemicStateEngine({clock:()=>new Date(T0)});
  one.observe({
    factKey:'target.visible',
    valueDigest:A,
    polarity:'supports',
    confidence:0.9,
    evidence:{digest:B,source:'dom',observedAt:T0}
  });
  const state=one.exportState();
  state.claims.push(structuredClone(state.claims[0]!));
  assert.throws(()=>EpistemicStateEngine.fromState(state),/duplicate claims/);
});

test('causal graph round-trips exact deterministic transition truth',()=>{
  const graph=new CausalGraph({clock:()=>new Date(T0)});
  graph.record({
    before:{
      id:'before',
      observedAt:T0,
      scopeKey:'scene',
      stateVersion:'v1',
      facts:[{key:'dialog.open',valueDigest:A,confidence:1,evidence:[]}]
    },
    action:{
      id:'action-1',
      family:'semantic-activation',
      capability:'ui.interact',
      risk:'write',
      expectedEffects:['dialog.open']
    },
    outcome:{
      ok:true,
      sideEffectState:'known',
      executionPhase:'effect_observed',
      evidence:[]
    },
    after:{
      id:'after',
      observedAt:T0,
      scopeKey:'scene',
      stateVersion:'v2',
      facts:[{key:'dialog.open',valueDigest:B,confidence:1,evidence:[]}]
    },
    progressSignals:['dialog-opened']
  });

  const state=graph.exportState();
  const restored=CausalGraph.fromState(state,{clock:()=>new Date(T0)});
  assert.deepEqual(restored.exportState(),state);
});

test('causal restore rejects tampered delta and confidence',()=>{
  const graph=new CausalGraph({clock:()=>new Date(T0)});
  graph.record({
    before:{id:'b',observedAt:T0,scopeKey:'scene',facts:[{key:'x',valueDigest:A,confidence:1,evidence:[]}]},
    action:{id:'a',family:'write',capability:'ui.interact',risk:'write',expectedEffects:['x']},
    outcome:{ok:true,sideEffectState:'known',executionPhase:'effect_observed',evidence:[]},
    after:{id:'c',observedAt:T0,scopeKey:'scene',facts:[{key:'x',valueDigest:B,confidence:1,evidence:[]}]}
  });
  const deltaCorrupt=graph.exportState();
  deltaCorrupt[0]!.delta.changedFactKeys=[];
  assert.throws(()=>CausalGraph.fromState(deltaCorrupt),/delta does not match/);

  const confidenceCorrupt=graph.exportState();
  confidenceCorrupt[0]!.causalConfidence=0;
  assert.throws(()=>CausalGraph.fromState(confidenceCorrupt),/confidence does not match/);
});

test('calibration state round-trips with identical report',()=>{
  const one=new CalibrationTracker({maxSamples:10});
  one.record({prediction:0.9,outcome:1,bucket:'strategy'});
  one.record({prediction:0.2,outcome:0,bucket:'recovery'});
  const state=one.snapshot();
  const two=CalibrationTracker.fromSnapshot(state,{maxSamples:10});
  assert.deepEqual(two.snapshot(),state);
  assert.deepEqual(two.report(),one.report());
});

function skill():SkillDraft{
  return{
    id:'generic-hierarchy',
    objectiveKind:'navigate-hierarchy',
    title:'Navigate a dynamically revealed hierarchy',
    scopeClass:'authorized-ui',
    assumptions:['semantic observation is available'],
    steps:[{
      actionFamily:'hierarchy-discovery',
      capability:'ui.observe',
      preconditions:['parent-visible'],
      expectedEffects:['children-discovered'],
      verificationFacts:['children-actionable']
    }],
    verificationDigests:[A],
    sourceRunIds:['run-1']
  };
}

function verification():LearningVerificationReceiptRef{
  return{
    digest:A,
    goalId:'goal-1',
    verifierId:'verification-kernel',
    verifiedAt:T0,
    authoritySnapshotDigest:B,
    sourceRunId:'run-1'
  };
}

test('learning replay guard survives restart and still rejects equivalent promotion',()=>{
  const one=new LearningFirewall({clock:()=>new Date(T0)});
  const first=one.evaluate({
    skill:skill(),
    mode:'NORMAL',
    policyVersion:'p1',
    verificationReceipts:[verification()]
  });
  assert.equal(first.promoted,true);

  const state=one.exportState();
  assert.equal(state.length,1);
  assert.match(state[0]!,/^[0-9a-f]{64}$/);

  const two=LearningFirewall.fromState(state,{clock:()=>new Date(T0)});
  const replay=two.evaluate({
    skill:skill(),
    mode:'NORMAL',
    policyVersion:'p1',
    verificationReceipts:[verification()]
  });
  assert.equal(replay.promoted,false);
  assert.match(replay.reason,/already been emitted/);
});
