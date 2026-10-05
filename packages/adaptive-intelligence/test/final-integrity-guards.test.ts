import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DecisionTraceLog,
  compareShadowToControl,
  createEvaluationFreezeManifest,
  sameEvaluationCandidate,
  selectObservation,
  verifyEvaluationFreezeManifest
} from '../src/index.ts';

const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),D='d'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';

function freezeBase(){
  return{
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
}

test('evaluation manifest comparison recomputes integrity instead of trusting copied digest',()=>{
  const manifest=createEvaluationFreezeManifest(freezeBase(),{clock:()=>new Date(T0)});
  assert.equal(verifyEvaluationFreezeManifest(manifest),true);

  const tampered={...manifest,modelId:'tampered-model'};
  assert.equal(verifyEvaluationFreezeManifest(tampered),false);
  assert.equal(sameEvaluationCandidate(manifest,tampered),false);
});

test('evaluation seed rejects arbitrary object coercion',()=>{
  assert.throws(()=>createEvaluationFreezeManifest({
    ...freezeBase(),
    seed:{value:1} as any
  },{clock:()=>new Date(T0)}),/seed must be a string or safe integer/);
});

test('benchmark identity must include both id and digest',()=>{
  const base=freezeBase();
  assert.throws(()=>createEvaluationFreezeManifest({
    ...base,
    benchmarkDigest:undefined
  },{clock:()=>new Date(T0)}),/must be supplied together/);
});

test('observation policy rejects string boolean coercion for targetLocal',()=>{
  assert.throws(()=>selectObservation([], [{
    id:'bad',
    channel:'dom',
    description:'bad runtime input',
    resolvesFacts:['x'],
    expectedInformationGain:0.5,
    expectedCost:1,
    targetLocal:'false' as any
  }]),/targetLocal must be boolean/);
});

test('observation policy rejects string boolean coercion for mutating',()=>{
  assert.throws(()=>selectObservation([], [{
    id:'bad',
    channel:'dom',
    description:'bad runtime input',
    resolvesFacts:['x'],
    expectedInformationGain:0.5,
    expectedCost:1,
    targetLocal:true,
    mutating:'false' as any
  }]),/mutating must be boolean/);
});

function traces(){
  const log=new DecisionTraceLog({clock:()=>new Date(T0)});
  const shadow=log.append({
    mode:'SHADOW',
    kind:'STRATEGY',
    runId:'run-1',
    taskId:'task-1',
    goalId:'goal-1',
    policyVersion:'candidate',
    decisionPointId:'p1',
    selectedId:'keyboard',
    alternatives:['pointer'],
    reason:'candidate',
    evidence:[],
    authoritySnapshotDigest:A,
    inputStateDigest:B
  });
  const control=log.append({
    mode:'CONTROL',
    kind:'STRATEGY',
    runId:'run-1',
    taskId:'task-1',
    goalId:'goal-1',
    policyVersion:'baseline',
    decisionPointId:'p1',
    selectedId:'pointer',
    alternatives:['keyboard'],
    reason:'baseline',
    evidence:[],
    authoritySnapshotDigest:A,
    inputStateDigest:B
  });
  return{log,shadow,control};
}
function outcome(decisionDigest:string,digest:string,result:'success'|'failure',progressScore:number){
  return{
    runId:'run-1',
    taskId:'task-1',
    goalId:'goal-1',
    decisionDigest,
    verificationReceipt:{
      digest,
      runId:'run-1',
      taskId:'task-1',
      goalId:'goal-1',
      decisionDigest,
      verifierId:'evaluation-verifier',
      verifiedAt:T0,
      authoritySnapshotDigest:A,
      outcome:result
    },
    progressScore,
    cost:1
  };
}

test('shadow progress evidence is bounded to a unit score',()=>{
  const {log,shadow,control}=traces();
  assert.throws(()=>compareShadowToControl(log.snapshot(),[
    outcome(shadow.decisionDigest,C,'success',2),
    outcome(control.decisionDigest,D,'failure',0)
  ],{now:new Date(T0)}),/between 0 and 1/);
});


test('evaluation revision rejects numeric coercion',()=>{
  assert.throws(()=>createEvaluationFreezeManifest({
    ...freezeBase(),
    sourceRevision:1234567 as any
  },{clock:()=>new Date(T0)}),/sourceRevision must be a string/);
});

test('shadow metric fields reject numeric strings',()=>{
  const {log,shadow,control}=traces();
  assert.throws(()=>compareShadowToControl(log.snapshot(),[
    {
      ...outcome(shadow.decisionDigest,C,'success',1),
      progressScore:'1' as any
    },
    outcome(control.decisionDigest,D,'failure',0)
  ],{now:new Date(T0)}),/progressScore must be a number/);

  assert.throws(()=>compareShadowToControl(log.snapshot(),[
    {
      ...outcome(shadow.decisionDigest,C,'success',1),
      cost:'1' as any
    },
    outcome(control.decisionDigest,D,'failure',0)
  ],{now:new Date(T0)}),/cost must be a number/);
});
