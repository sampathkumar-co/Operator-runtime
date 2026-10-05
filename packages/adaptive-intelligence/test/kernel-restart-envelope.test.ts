import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AdaptiveIntelligenceKernel
} from '../src/index.ts';
import type {
  AdaptiveIntelligenceKernelState,
  LearningVerificationReceiptRef,
  SkillDraft
} from '../src/index.ts';

const T0='2026-10-05T00:00:00.000Z';
const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),D='d'.repeat(64);
const digests=[
  '0'.repeat(64),'1'.repeat(64),'2'.repeat(64),'3'.repeat(64),
  '4'.repeat(64),'5'.repeat(64),'6'.repeat(64),'7'.repeat(64)
];

function analyze(kernel:AdaptiveIntelligenceKernel,index:number){
  return kernel.analyzeOutcome({
    goal:{
      id:'long-goal',
      kind:'synthetic-long',
      objective:'advance synthetic state',
      successFactKeys:['goal.done']
    },
    before:{
      id:'before-'+index,
      observedAt:T0,
      scopeKey:'scene',
      stateVersion:'v'+index,
      facts:[{key:'counter',valueDigest:digests[index]!,confidence:1,evidence:[]}]
    },
    action:{
      id:'action-'+index,
      family:'semantic-write',
      capability:'ui.interact',
      risk:'write',
      expectedEffects:['counter']
    },
    outcome:{
      ok:true,
      sideEffectState:'known',
      executionPhase:'effect_observed',
      evidence:[]
    },
    after:{
      id:'after-'+index,
      observedAt:T0,
      scopeKey:'scene',
      stateVersion:'v'+(index+1),
      facts:[{key:'counter',valueDigest:digests[index+1]!,confidence:1,evidence:[]}]
    },
    relevantFactKeys:['goal.done'],
    progressSignals:['advance']
  });
}

function skill():SkillDraft{
  return{
    id:'generic-state-advance',
    objectiveKind:'state-advance',
    title:'Advance an authorized state with verification',
    scopeClass:'authorized-state',
    assumptions:['target state is observable'],
    steps:[{
      actionFamily:'semantic-write',
      capability:'ui.interact',
      preconditions:['target-observed'],
      expectedEffects:['target-updated'],
      verificationFacts:['target-updated']
    }],
    verificationDigests:[A],
    sourceRunIds:['run-1']
  };
}

function learningReceipt():LearningVerificationReceiptRef{
  return{
    digest:A,
    goalId:'learning-goal',
    verifierId:'verification-kernel',
    verifiedAt:T0,
    authoritySnapshotDigest:B,
    sourceRunId:'run-1'
  };
}

test('full kernel state round-trips all standalone reasoning state',()=>{
  const kernel=new AdaptiveIntelligenceKernel({
    clock:()=>new Date(T0),
    maxTrajectorySteps:3,
    maxTransitions:5,
    maxCalibrationSamples:10
  });

  kernel.observeBelief({
    factKey:'target.visible',
    valueDigest:C,
    polarity:'supports',
    confidence:0.9,
    evidence:{
      digest:D,
      source:'dom',
      channel:'dom',
      observedAt:T0,
      independenceKey:'dom-1'
    }
  });
  kernel.calibration.record({prediction:0.8,outcome:1,bucket:'strategy'});
  const promoted=kernel.promoteSkill({
    skill:skill(),
    mode:'NORMAL',
    policyVersion:'p1',
    verificationReceipts:[learningReceipt()]
  });
  assert.equal(promoted.promoted,true);

  for(let i=0;i<5;i+=1) analyze(kernel,i);

  assert.deepEqual(kernel.trajectory().map(step=>step.index),[2,3,4]);
  assert.equal(kernel.compressedTrajectory({
    id:'long-goal',
    kind:'synthetic-long',
    objective:'advance synthetic state',
    successFactKeys:['goal.done']
  },['target.visible']).omittedSteps,2);

  const state=kernel.exportState();
  assert.equal(state.nextTrajectoryIndex,5);
  assert.equal(state.epistemic.claims.length,1);
  assert.equal(state.calibration.length,1);
  assert.equal(state.learningReplayDigests.length,1);
  assert.equal(state.causal.length,5);

  const restored=AdaptiveIntelligenceKernel.fromState(state,{
    clock:()=>new Date(T0),
    maxTrajectorySteps:3,
    maxTransitions:5,
    maxCalibrationSamples:10
  });
  assert.deepEqual(restored.exportState(),state);

  const replay=restored.promoteSkill({
    skill:skill(),
    mode:'NORMAL',
    policyVersion:'p1',
    verificationReceipts:[learningReceipt()]
  });
  assert.equal(replay.promoted,false);

  analyze(restored,5);
  assert.deepEqual(restored.trajectory().map(step=>step.index),[3,4,5]);
  assert.equal(restored.exportState().nextTrajectoryIndex,6);
});

test('kernel envelope round-trips and rejects payload tampering',()=>{
  const kernel=new AdaptiveIntelligenceKernel({
    clock:()=>new Date(T0),
    maxTrajectorySteps:3,
    maxTransitions:5
  });
  analyze(kernel,0);
  analyze(kernel,1);

  const envelope=kernel.exportEnvelope({clock:()=>new Date(T0)});
  const restored=AdaptiveIntelligenceKernel.fromEnvelope(envelope,{
    clock:()=>new Date(T0),
    maxTrajectorySteps:3,
    maxTransitions:5
  });
  assert.deepEqual(restored.exportState(),kernel.exportState());

  const corrupted=structuredClone(envelope);
  corrupted.payload.nextTrajectoryIndex=999;
  assert.throws(()=>AdaptiveIntelligenceKernel.fromEnvelope(corrupted,{
    maxTrajectorySteps:3,
    maxTransitions:5
  }),/payload digest mismatch/);
});

test('kernel restore rejects trajectory execution truth that disagrees with causal history',()=>{
  const kernel=new AdaptiveIntelligenceKernel({
    clock:()=>new Date(T0),
    maxTrajectorySteps:3,
    maxTransitions:5
  });
  analyze(kernel,0);
  const state=kernel.exportState();
  state.trajectory[0]!.action.family='tampered-family';
  assert.throws(()=>AdaptiveIntelligenceKernel.fromState(state,{
    maxTrajectorySteps:3,
    maxTransitions:5
  }),/does not match causal history/);
});

test('kernel restore rejects non-contiguous or forged next trajectory sequence',()=>{
  const kernel=new AdaptiveIntelligenceKernel({
    clock:()=>new Date(T0),
    maxTrajectorySteps:3,
    maxTransitions:5
  });
  analyze(kernel,0);
  analyze(kernel,1);
  const state=kernel.exportState();

  const nextCorrupt=structuredClone(state);
  nextCorrupt.nextTrajectoryIndex=99;
  assert.throws(()=>AdaptiveIntelligenceKernel.fromState(nextCorrupt,{
    maxTrajectorySteps:3,
    maxTransitions:5
  }),/next trajectory index/);

  const indexCorrupt=structuredClone(state) as AdaptiveIntelligenceKernelState;
  indexCorrupt.trajectory[1]!.index=7;
  indexCorrupt.nextTrajectoryIndex=8;
  assert.throws(()=>AdaptiveIntelligenceKernel.fromState(indexCorrupt,{
    maxTrajectorySteps:3,
    maxTransitions:5
  }),/strictly contiguous/);
});
