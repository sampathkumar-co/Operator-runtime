import assert from 'node:assert/strict';
import test from 'node:test';
import { computeIntelligenceMetrics } from '../src/index.ts';
import type { TrajectoryStep } from '../src/index.ts';

const A='a'.repeat(64),B='b'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';
const RUN='run-1';
const TASK='task-1';

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
function receipt(
  goalId:string,
  overrides:Partial<{runId:string;taskId:string;verifiedAt:string}>={}
){
  return{
    digest:A,
    runId:overrides.runId??RUN,
    taskId:overrides.taskId??TASK,
    goalId,
    verifierId:'verification-kernel',
    verifiedAt:overrides.verifiedAt??T0,
    authoritySnapshotDigest:B
  };
}

test('goal-achieved step without final receipt is counted as false goal progress',()=>{
  const metrics=computeIntelligenceMetrics([{
    runId:RUN,
    taskId:TASK,
    goalId:'goal-1',
    steps:[successStep()]
  }],{now:new Date(T0)});
  assert.equal(metrics.firstStrategySuccessRate,0);
  assert.equal(metrics.falseGoalProgressRate,1);
});

test('run-task-goal-bound final receipt grounds first strategy success',()=>{
  const metrics=computeIntelligenceMetrics([{
    runId:RUN,
    taskId:TASK,
    goalId:'goal-1',
    steps:[successStep()],
    finalVerificationReceipt:receipt('goal-1')
  }],{now:new Date(T0)});
  assert.equal(metrics.firstStrategySuccessRate,1);
  assert.equal(metrics.falseGoalProgressRate,0);
});

test('final receipt bound to a different goal fails closed',()=>{
  assert.throws(()=>computeIntelligenceMetrics([{
    runId:RUN,
    taskId:TASK,
    goalId:'goal-1',
    steps:[successStep()],
    finalVerificationReceipt:receipt('other-goal')
  }],{now:new Date(T0)}),/different goal/);
});

test('final receipt cannot be replayed across tasks',()=>{
  assert.throws(()=>computeIntelligenceMetrics([{
    runId:RUN,
    taskId:TASK,
    goalId:'goal-1',
    steps:[successStep()],
    finalVerificationReceipt:receipt('goal-1',{taskId:'other-task'})
  }],{now:new Date(T0)}),/different task/);
});

test('final receipt cannot be replayed across evaluation runs',()=>{
  assert.throws(()=>computeIntelligenceMetrics([{
    runId:RUN,
    taskId:TASK,
    goalId:'goal-1',
    steps:[successStep()],
    finalVerificationReceipt:receipt('goal-1',{runId:'other-run'})
  }],{now:new Date(T0)}),/different run/);
});

test('future-dated final receipt fails closed',()=>{
  assert.throws(()=>computeIntelligenceMetrics([{
    runId:RUN,
    taskId:TASK,
    goalId:'goal-1',
    steps:[successStep()],
    finalVerificationReceipt:receipt('goal-1',{verifiedAt:'2026-10-05T00:00:01.000Z'})
  }],{now:new Date(T0)}),/future-dated/);
});

test('computed metrics bind their own run and canonical task cohort',()=>{
  const metrics=computeIntelligenceMetrics([
    {runId:RUN,taskId:'task-1',goalId:'goal-1',steps:[]},
    {runId:RUN,taskId:'task-2',goalId:'goal-2',steps:[]}
  ],{now:new Date(T0)});
  assert.equal(metrics.evaluationRunId,RUN);
  assert.match(metrics.taskCohortDigest??'',/^[0-9a-f]{64}$/);
});

test('computed metrics reject mixed evaluation runs and duplicate task identities',()=>{
  assert.throws(()=>computeIntelligenceMetrics([
    {runId:'run-a',taskId:'task-1',goalId:'goal-1',steps:[]},
    {runId:'run-b',taskId:'task-2',goalId:'goal-2',steps:[]}
  ],{now:new Date(T0)}),/multiple evaluation run ids/);

  assert.throws(()=>computeIntelligenceMetrics([
    {runId:RUN,taskId:'task-1',goalId:'goal-1',steps:[]},
    {runId:RUN,taskId:'task-1',goalId:'goal-2',steps:[]}
  ],{now:new Date(T0)}),/must be unique/);
});
