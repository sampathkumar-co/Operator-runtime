import assert from 'node:assert/strict';
import test from 'node:test';
import { DecisionTraceLog, compareShadowToControl } from '../src/index.ts';

const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),D='d'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';
const RUN='eval-run-1';
const GOAL='goal-1';

function pair(options:{decisionPointId?:string;shadowPolicy?:string;controlPolicy?:string}={}){
  const log=new DecisionTraceLog({clock:()=>new Date(T0)});
  const shadow=log.append({
    mode:'SHADOW',
    kind:'STRATEGY',
    runId:RUN,
    taskId:'task-1',
    goalId:GOAL,
    policyVersion:options.shadowPolicy??'candidate-v2',
    ...(options.decisionPointId?{decisionPointId:options.decisionPointId}:{}),
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
    runId:RUN,
    taskId:'task-1',
    goalId:GOAL,
    policyVersion:options.controlPolicy??'baseline-v1',
    ...(options.decisionPointId?{decisionPointId:options.decisionPointId}:{}),
    selectedId:'pointer',
    alternatives:['keyboard'],
    reason:'baseline',
    evidence:[],
    authoritySnapshotDigest:A,
    inputStateDigest:B
  });
  return{log,shadow,control};
}

function outcome(
  decisionDigest:string,
  result:'success'|'failure',
  overrides:Record<string,unknown>={}
){
  return{
    runId:RUN,
    taskId:'task-1',
    goalId:GOAL,
    decisionDigest,
    verificationReceipt:{
      digest:result==='success'?C:D,
      runId:RUN,
      taskId:'task-1',
      goalId:GOAL,
      decisionDigest,
      verifierId:'evaluation-verifier',
      verifiedAt:T0,
      authoritySnapshotDigest:A,
      outcome:result,
      ...overrides
    },
    progressScore:result==='success'?1:0,
    cost:1
  };
}

test('shadow comparison requires authoritative outcome receipts',()=>{
  const {log,shadow,control}=pair({decisionPointId:'point-1'});
  assert.throws(()=>compareShadowToControl(log.snapshot(),[
    {
      runId:RUN,
      taskId:'task-1',
      goalId:GOAL,
      decisionDigest:shadow.decisionDigest,
      progressScore:1,
      cost:1
    } as never,
    outcome(control.decisionDigest,'failure')
  ],{now:new Date(T0)}),/verification receipt is required/);
});

test('shadow outcome receipt authority must match the decision authority snapshot',()=>{
  const {log,shadow,control}=pair({decisionPointId:'point-1'});
  assert.throws(()=>compareShadowToControl(log.snapshot(),[
    outcome(shadow.decisionDigest,'success',{authoritySnapshotDigest:B}),
    outcome(control.decisionDigest,'failure')
  ],{now:new Date(T0)}),/authority snapshot does not match/);
});

test('shadow outcome receipt cannot predate its decision',()=>{
  const log=new DecisionTraceLog({clock:()=>new Date('2026-10-05T00:00:02.000Z')});
  const shadow=log.append({
    mode:'SHADOW',kind:'STRATEGY',runId:RUN,taskId:'task-1',goalId:GOAL,policyVersion:'candidate',
    decisionPointId:'point-1',selectedId:'a',reason:'a',evidence:[],
    authoritySnapshotDigest:A,inputStateDigest:B
  });
  const control=log.append({
    mode:'CONTROL',kind:'STRATEGY',runId:RUN,taskId:'task-1',goalId:GOAL,policyVersion:'baseline',
    decisionPointId:'point-1',selectedId:'b',reason:'b',evidence:[],
    authoritySnapshotDigest:A,inputStateDigest:B
  });
  assert.throws(()=>compareShadowToControl(log.snapshot(),[
    outcome(shadow.decisionDigest,'success',{verifiedAt:T0}),
    outcome(control.decisionDigest,'failure',{verifiedAt:T0})
  ],{now:new Date('2026-10-05T00:00:03.000Z')}),/cannot predate/);
});

test('shadow comparison rejects mixed candidate policy versions in one report',()=>{
  const log=new DecisionTraceLog({clock:()=>new Date(T0)});
  for(const [point,policy] of [['p1','candidate-a'],['p2','candidate-b']] as const){
    log.append({
      mode:'SHADOW',kind:'STRATEGY',runId:RUN,taskId:'task-1',goalId:GOAL,policyVersion:policy,
      decisionPointId:point,selectedId:'x',reason:'x',evidence:[],
      authoritySnapshotDigest:A,inputStateDigest:B
    });
  }
  log.append({
    mode:'CONTROL',kind:'STRATEGY',runId:RUN,taskId:'task-1',goalId:GOAL,policyVersion:'baseline',
    decisionPointId:'p1',selectedId:'y',reason:'y',evidence:[],
    authoritySnapshotDigest:A,inputStateDigest:B
  });
  assert.throws(()=>compareShadowToControl(log.snapshot(),[],{now:new Date(T0)}),/Mixed shadow policy versions/);
});

test('ambiguous repeated fallback pairing without decisionPointId is rejected',()=>{
  const log=new DecisionTraceLog({clock:()=>new Date(T0)});
  for(let i=0;i<2;i+=1){
    log.append({
      mode:'SHADOW',kind:'STRATEGY',runId:RUN,taskId:'task-1',goalId:GOAL,policyVersion:'candidate',
      selectedId:'s'+i,reason:'s',evidence:[],
      authoritySnapshotDigest:A,inputStateDigest:B
    });
    log.append({
      mode:'CONTROL',kind:'STRATEGY',runId:RUN,taskId:'task-1',goalId:GOAL,policyVersion:'baseline',
      selectedId:'c'+i,reason:'c',evidence:[],
      authoritySnapshotDigest:A,inputStateDigest:B
    });
  }
  assert.throws(()=>compareShadowToControl(log.snapshot(),[],{now:new Date(T0)}),/Ambiguous shadow\/control fallback pairing/);
});

test('receipt-bound shadow comparison still produces verified win/loss statistics',()=>{
  const {log,shadow,control}=pair({decisionPointId:'point-1'});
  const report=compareShadowToControl(log.snapshot(),[
    outcome(shadow.decisionDigest,'success'),
    outcome(control.decisionDigest,'failure')
  ],{now:new Date(T0)});
  assert.equal(report.pairedDecisions,1);
  assert.equal(report.pairedOutcomeDecisions,1);
  assert.equal(report.shadowWinRate,1);
  assert.equal(report.controlWinRate,0);
  assert.equal(report.outcomeCoverage,1);
});

test('shadow outcome run and goal identity must match both trace and receipt',()=>{
  const {log,shadow,control}=pair({decisionPointId:'point-1'});
  assert.throws(()=>compareShadowToControl(log.snapshot(),[
    {...outcome(shadow.decisionDigest,'success'),runId:'other-run'},
    outcome(control.decisionDigest,'failure')
  ],{now:new Date(T0)}),/run id does not match/);

  assert.throws(()=>compareShadowToControl(log.snapshot(),[
    outcome(shadow.decisionDigest,'success',{goalId:'other-goal'}),
    outcome(control.decisionDigest,'failure')
  ],{now:new Date(T0)}),/receipt goal id does not match/);
});
