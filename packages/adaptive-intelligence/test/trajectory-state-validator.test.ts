import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AdaptiveIntelligenceKernel,
  validateStoredTrajectoryAdvisory
} from '../src/index.ts';
import type { TrajectoryStep } from '../src/index.ts';

const T0='2026-10-05T00:00:00.000Z';
const A='a'.repeat(64),B='b'.repeat(64);

function baseStep():TrajectoryStep{
  return{
    index:0,
    action:{
      id:'action-0',
      family:'semantic-write',
      capability:'ui.interact',
      risk:'write',
      expectedEffects:['target.updated']
    },
    outcome:{
      ok:false,
      errorCode:'NO_PROGRESS',
      sideEffectState:'none',
      executionPhase:'effect_observed',
      evidence:[]
    },
    delta:{
      changedFactKeys:[],
      addedFactKeys:[],
      removedFactKeys:[],
      expectedEffectsSatisfied:[],
      expectedEffectsMissing:['target.updated'],
      unrelatedEffects:[],
      progressSignals:[]
    },
    progress:{
      level:'NONE',
      confidence:0,
      creditedSignals:[],
      rejectedSignals:['provider-action-failed'],
      goalFactsSatisfied:[],
      goalFactsMissing:['goal.done'],
      forbiddenFactsObserved:[],
      verificationRequired:true
    },
    failure:{
      primary:{
        class:'ACTION_NO_EFFECT',
        probability:0.7,
        reasons:['expected effect is missing'],
        evidence:[]
      },
      alternatives:[{
        class:'PLANNER_STRATEGY_WRONG',
        probability:0.3,
        reasons:['selected strategy may be inappropriate'],
        evidence:[]
      }],
      entropy:0.88,
      evidenceCoverage:0.5
    }
  };
}

test('valid persisted advisory trajectory state is accepted',()=>{
  assert.doesNotThrow(()=>validateStoredTrajectoryAdvisory(baseStep()));
});

test('persisted GOAL_ACHIEVED cannot carry missing or forbidden facts',()=>{
  const step=baseStep();
  step.progress={
    ...step.progress,
    level:'GOAL_ACHIEVED',
    confidence:0.99,
    verificationRequired:false,
    goalFactsSatisfied:['goal.done'],
    goalFactsMissing:['goal.other']
  };
  assert.throws(()=>validateStoredTrajectoryAdvisory(step),/missing goal facts/);

  step.progress.goalFactsMissing=[];
  step.progress.forbiddenFactsObserved=['goal.forbidden'];
  assert.throws(()=>validateStoredTrajectoryAdvisory(step),/forbidden facts/);
});

test('non-final persisted progress cannot claim verification complete',()=>{
  const step=baseStep();
  step.progress.verificationRequired=false;
  assert.throws(()=>validateStoredTrajectoryAdvisory(step),/verification-required/);
});

test('failure probability mass and class identity fail closed',()=>{
  const badMass=baseStep();
  badMass.failure!.primary.probability=0.9;
  assert.throws(()=>validateStoredTrajectoryAdvisory(badMass),/sum to one/);

  const duplicate=baseStep();
  duplicate.failure!.alternatives[0]!.class='ACTION_NO_EFFECT';
  assert.throws(()=>validateStoredTrajectoryAdvisory(duplicate),/classes must be unique/);
});

test('failure evidence metadata is runtime validated',()=>{
  const step=baseStep();
  step.failure!.primary.evidence=[{
    digest:'bad',
    source:'source',
    observedAt:T0
  }];
  assert.throws(()=>validateStoredTrajectoryAdvisory(step),/SHA-256/);
});

test('kernel restore rejects poisoned progress metadata even when execution truth is unchanged',()=>{
  const kernel=new AdaptiveIntelligenceKernel({
    clock:()=>new Date(T0),
    maxTrajectorySteps:5,
    maxTransitions:5
  });
  kernel.analyzeOutcome({
    goal:{
      id:'goal-1',
      kind:'synthetic',
      objective:'update target',
      successFactKeys:['goal.done']
    },
    before:{
      id:'before',
      observedAt:T0,
      scopeKey:'scene',
      facts:[{key:'target.updated',valueDigest:A,confidence:1,evidence:[]}]
    },
    action:{
      id:'action',
      family:'semantic-write',
      capability:'ui.interact',
      risk:'write',
      expectedEffects:['target.updated']
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
      facts:[{key:'target.updated',valueDigest:B,confidence:1,evidence:[]}]
    },
    relevantFactKeys:['goal.done'],
    progressSignals:['updated']
  });

  const state=kernel.exportState();
  state.trajectory[0]!.progress.confidence=7;
  assert.throws(()=>AdaptiveIntelligenceKernel.fromState(state,{
    clock:()=>new Date(T0),
    maxTrajectorySteps:5,
    maxTransitions:5
  }),/progress confidence/);
});
