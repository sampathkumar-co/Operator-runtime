import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DecisionTraceLog,
  HypothesisGraph,
  computeIntelligenceMetrics,
  createEvaluationFreezeManifest,
  sameEvaluationCandidate
} from '../src/index.ts';
import type { TrajectoryStep } from '../src/index.ts';

const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),D='d'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';
function ev(digest=A){return{digest,source:'test',observedAt:T0};}
function finalReceipt(goalId:string,taskId:string,runId='eval-run-1'){
  return{
    digest:A,
    runId,
    taskId,
    goalId,
    verifierId:'verification-kernel',
    verifiedAt:T0,
    authoritySnapshotDigest:B
  };
}

test('hierarchical hypotheses preserve scope and unresolved dependencies',()=>{
  const graph=new HypothesisGraph({clock:()=>new Date(T0)});
  graph.add({
    id:'env-stale',
    scope:'environment',
    class:'STATE_CHANGED_EXTERNALLY',
    statement:'environment may have changed',
    confidence:0.6
  });
  graph.add({
    id:'target-stale',
    scope:'target',
    class:'TARGET_STALE',
    statement:'target identity may be stale',
    confidence:0.8,
    dependsOn:['env-stale']
  });
  assert.equal(graph.active('target')[0]?.id,'target-stale');
  assert.equal(graph.unresolvedDependencies('target-stale')[0]?.id,'env-stale');
  graph.updateEvidence('env-stale',{state:'RESOLVED',support:[ev()]});
  assert.equal(graph.unresolvedDependencies('target-stale').length,0);
});

test('evaluation freeze manifest changes when model or runner changes',()=>{
  const base={
    sourceRevision:'a'.repeat(40),
    intelligencePolicyVersion:'p1',
    intelligencePolicyDigest:A,
    adaptiveStateDigest:B,
    authorityPolicyDigest:C,
    procedureSnapshotDigest:D,
    modelProvider:'provider',
    modelId:'model-a',
    modelConfigDigest:A,
    environmentId:'env',
    environmentDigest:B,
    runnerDigest:C,
    benchmarkId:'public-suite',
    benchmarkDigest:D,
    seed:0
  };
  const one=createEvaluationFreezeManifest(base,{clock:()=>new Date(T0)});
  const two=createEvaluationFreezeManifest(base,{clock:()=>new Date(T0)});
  const three=createEvaluationFreezeManifest({...base,modelId:'model-b'},{clock:()=>new Date(T0)});
  const changedPolicy=createEvaluationFreezeManifest({...base,intelligencePolicyDigest:B},{clock:()=>new Date(T0)});
  const changedBenchmark=createEvaluationFreezeManifest({...base,benchmarkDigest:C},{clock:()=>new Date(T0)});
  assert.equal(sameEvaluationCandidate(one,two),true);
  assert.equal(sameEvaluationCandidate(one,three),false);
  assert.equal(sameEvaluationCandidate(one,changedPolicy),false);
  assert.equal(sameEvaluationCandidate(one,changedBenchmark),false);
});

function step(index:number,family:string,ok:boolean,progress:'NONE'|'SUBGOAL_PROGRESS'|'GOAL_ACHIEVED',failure=false):TrajectoryStep{
  return{
    index,
    action:{id:'a'+index,family,capability:'ui.interact',risk:'write',expectedEffects:['goal.done']},
    outcome:{ok,sideEffectState:ok?'known':'none',executionPhase:'effect_observed',evidence:[]},
    delta:{
      changedFactKeys:ok?['goal.done']:[],
      addedFactKeys:[],
      removedFactKeys:[],
      expectedEffectsSatisfied:ok?['goal.done']:[],
      expectedEffectsMissing:ok?[]:['goal.done'],
      unrelatedEffects:[],
      progressSignals:ok?['done']:[]
    },
    progress:{
      level:progress,
      confidence:ok?0.9:0,
      creditedSignals:[],
      rejectedSignals:[],
      goalFactsSatisfied:ok?['goal.done']:[],
      goalFactsMissing:ok?[]:['goal.done'],
      forbiddenFactsObserved:[],
      verificationRequired:progress!=='GOAL_ACHIEVED'
    },
    ...(failure?{
      failure:{
        primary:{class:'ACTION_NO_EFFECT',probability:1,reasons:['no effect'],evidence:[]},
        alternatives:[],
        entropy:0,
        evidenceCoverage:0.5
      }
    }:{})
  };
}

test('intelligence metrics surface recovery and repeated-failure quality',()=>{
  const metrics=computeIntelligenceMetrics([
    {runId:'eval-run-1',taskId:'t1',goalId:'g1',steps:[step(0,'pointer',true,'GOAL_ACHIEVED')],finalVerificationReceipt:finalReceipt('g1','t1')},
    {runId:'eval-run-1',taskId:'t2',steps:[
      step(0,'pointer',false,'NONE',true),
      step(1,'pointer',false,'NONE',true),
      step(2,'keyboard',true,'GOAL_ACHIEVED')
    ],goalId:'g2',finalVerificationReceipt:finalReceipt('g2','t2')},
    {runId:'eval-run-1',taskId:'t3',goalId:'g3',steps:[step(0,'pointer',true,'GOAL_ACHIEVED')]}
  ]);
  assert.equal(metrics.taskCount,3);
  assert.ok(metrics.recoverySuccessRate>0);
  assert.ok(metrics.repeatedEquivalentFailureRate>0);
  assert.ok(metrics.falseGoalProgressRate>0);
});

test('decision trace binds shadow recommendation to authority and state digests',()=>{
  const log=new DecisionTraceLog({clock:()=>new Date(T0)});
  const record=log.append({
    mode:'SHADOW',
    kind:'RECOVERY',
    runId:'run-1',
    taskId:'t1',
    goalId:'goal-1',
    policyVersion:'p1',
    selectedId:'reobserve',
    alternatives:['retry'],
    reason:'target confidence is low',
    evidence:[ev()],
    authoritySnapshotDigest:A,
    inputStateDigest:B
  });
  assert.equal(record.mode,'SHADOW');
  assert.match(record.decisionDigest,/^[0-9a-f]{64}$/);
  assert.equal(log.recent(1)[0]?.decisionDigest,record.decisionDigest);
});
