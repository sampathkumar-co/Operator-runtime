import assert from 'node:assert/strict';
import test from 'node:test';
import { computeIntelligenceMetrics } from '../src/index.ts';
import type { TrajectoryStep } from '../src/index.ts';

const A='a'.repeat(64),B='b'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';

function successStep():TrajectoryStep{
  return{
    index:0,
    action:{id:'a1',family:'semantic',capability:'ui.interact',risk:'write',expectedEffects:['goal.done']},
    outcome:{ok:true,sideEffectState:'known',executionPhase:'effect_observed',evidence:[]},
    delta:{
      changedFactKeys:['goal.done'],
      addedFactKeys:[],removedFactKeys:[],
      expectedEffectsSatisfied:['goal.done'],
      expectedEffectsMissing:[],
      unrelatedEffects:[],
      progressSignals:['done']
    },
    progress:{
      level:'GOAL_ACHIEVED',
      confidence:0.95,
      creditedSignals:['independent-goal-verification'],
      rejectedSignals:[],
      goalFactsSatisfied:['goal.done'],
      goalFactsMissing:[],
      forbiddenFactsObserved:[],
      verificationRequired:false
    }
  };
}
function receipt(goalId:string,verifiedAt=T0){
  return{
    digest:A,
    goalId,
    verifierId:'verification-kernel',
    verifiedAt,
    authoritySnapshotDigest:B
  };
}

test('goal-achieved step without final receipt is counted as false goal progress',()=>{
  const metrics=computeIntelligenceMetrics([{
    taskId:'task-1',
    goalId:'goal-1',
    steps:[successStep()]
  }],{now:new Date(T0)});
  assert.equal(metrics.firstStrategySuccessRate,0);
  assert.equal(metrics.falseGoalProgressRate,1);
});

test('goal-bound final receipt grounds first strategy success',()=>{
  const metrics=computeIntelligenceMetrics([{
    taskId:'task-1',
    goalId:'goal-1',
    steps:[successStep()],
    finalVerificationReceipt:receipt('goal-1')
  }],{now:new Date(T0)});
  assert.equal(metrics.firstStrategySuccessRate,1);
  assert.equal(metrics.falseGoalProgressRate,0);
});

test('final receipt bound to a different goal fails closed',()=>{
  assert.throws(()=>computeIntelligenceMetrics([{
    taskId:'task-1',
    goalId:'goal-1',
    steps:[successStep()],
    finalVerificationReceipt:receipt('other-goal')
  }],{now:new Date(T0)}),/different goal/);
});

test('future-dated final receipt fails closed',()=>{
  assert.throws(()=>computeIntelligenceMetrics([{
    taskId:'task-1',
    goalId:'goal-1',
    steps:[successStep()],
    finalVerificationReceipt:receipt('goal-1','2026-10-05T00:00:01.000Z')
  }],{now:new Date(T0)}),/future-dated/);
});
