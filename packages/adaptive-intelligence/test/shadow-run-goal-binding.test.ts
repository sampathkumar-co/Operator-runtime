import assert from 'node:assert/strict';
import test from 'node:test';
import { DecisionTraceLog, compareShadowToControl } from '../src/index.ts';

const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),D='d'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';

function append(
  log:DecisionTraceLog,
  mode:'SHADOW'|'CONTROL',
  runId:string,
  goalId:string,
  selectedId:string
){
  return log.append({
    mode,
    kind:'STRATEGY',
    runId,
    taskId:'task-1',
    goalId,
    policyVersion:mode==='SHADOW'?'candidate-p1':'baseline-p0',
    decisionPointId:'step-1',
    selectedId,
    alternatives:selectedId==='keyboard'?['pointer']:['keyboard'],
    reason:'synthetic comparison',
    evidence:[],
    authoritySnapshotDigest:A,
    inputStateDigest:B
  });
}

function outcome(
  trace:ReturnType<DecisionTraceLog['append']>,
  result:'success'|'failure',
  overrides:Record<string,unknown>={}
){
  return{
    runId:trace.runId,
    taskId:trace.taskId,
    goalId:trace.goalId,
    decisionDigest:trace.decisionDigest,
    verificationReceipt:{
      digest:result==='success'?C:D,
      runId:trace.runId,
      taskId:trace.taskId,
      goalId:trace.goalId,
      decisionDigest:trace.decisionDigest,
      verifierId:'evaluation-verifier',
      verifiedAt:T0,
      authoritySnapshotDigest:trace.authoritySnapshotDigest,
      outcome:result
    },
    ...overrides
  } as any;
}

test('shadow comparison rejects traces mixed across evaluation runs',()=>{
  const log=new DecisionTraceLog({clock:()=>new Date(T0)});
  append(log,'SHADOW','run-1','goal-1','keyboard');
  append(log,'CONTROL','run-2','goal-1','pointer');

  assert.throws(
    ()=>compareShadowToControl(log.recent(10),[],{now:new Date(T0)}),
    /Mixed evaluation run ids/
  );
});

test('outcome run id must match the decision trace',()=>{
  const log=new DecisionTraceLog({clock:()=>new Date(T0)});
  const shadow=append(log,'SHADOW','run-1','goal-1','keyboard');
  const control=append(log,'CONTROL','run-1','goal-1','pointer');

  assert.throws(()=>compareShadowToControl(log.recent(10),[
    outcome(shadow,'success',{runId:'other-run'}),
    outcome(control,'failure')
  ],{now:new Date(T0)}),/run id does not match/);
});

test('outcome goal id must match the decision trace',()=>{
  const log=new DecisionTraceLog({clock:()=>new Date(T0)});
  const shadow=append(log,'SHADOW','run-1','goal-1','keyboard');
  const control=append(log,'CONTROL','run-1','goal-1','pointer');

  assert.throws(()=>compareShadowToControl(log.recent(10),[
    outcome(shadow,'success',{goalId:'other-goal'}),
    outcome(control,'failure')
  ],{now:new Date(T0)}),/goal id does not match/);
});

test('verification receipt run and goal bindings cannot be reused across another trace',()=>{
  const log=new DecisionTraceLog({clock:()=>new Date(T0)});
  const shadow=append(log,'SHADOW','run-1','goal-1','keyboard');
  const control=append(log,'CONTROL','run-1','goal-1','pointer');

  assert.throws(()=>compareShadowToControl(log.recent(10),[
    outcome(shadow,'success',{
      verificationReceipt:{
        digest:C,
        runId:'run-1',
        taskId:shadow.taskId,
        goalId:'other-goal',
        decisionDigest:shadow.decisionDigest,
        verifierId:'evaluation-verifier',
        verifiedAt:T0,
        authoritySnapshotDigest:A,
        outcome:'success'
      }
    }),
    outcome(control,'failure')
  ],{now:new Date(T0)}),/receipt goal id does not match/);
});

test('properly bound run/goal outcome receipts still compare normally',()=>{
  const log=new DecisionTraceLog({clock:()=>new Date(T0)});
  const shadow=append(log,'SHADOW','run-1','goal-1','keyboard');
  const control=append(log,'CONTROL','run-1','goal-1','pointer');

  const report=compareShadowToControl(log.recent(10),[
    outcome(shadow,'success'),
    outcome(control,'failure')
  ],{now:new Date(T0)});
  assert.equal(report.pairedDecisions,1);
  assert.equal(report.pairedOutcomeDecisions,1);
  assert.equal(report.shadowWinRate,1);
});
