import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DecisionTraceLog,
  PromotionLedger,
  compareShadowToControl,
  decodeVersionedState,
  encodeVersionedState,
  pruneHypotheses
} from '../src/index.ts';
import type { HypothesisNode } from '../src/index.ts';

const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),D='d'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';

test('versioned state round-trips canonically and rejects corruption/unknown versions',()=>{
  const envelope=encodeVersionedState('trajectory',{b:2,a:1},{clock:()=>new Date(T0)});
  const decoded=decodeVersionedState(envelope,{
    kind:'trajectory',
    validate:(payload)=>{
      assert.equal(typeof payload,'object');
      return payload as {a:number;b:number};
    }
  });
  assert.deepEqual(decoded.payload,{b:2,a:1});

  assert.throws(()=>decodeVersionedState({...envelope,payload:{a:99,b:2}},{
    kind:'trajectory',
    validate:(payload)=>payload as {a:number;b:number}
  }),/digest mismatch/);

  assert.throws(()=>decodeVersionedState({...envelope,version:999},{
    kind:'trajectory',
    validate:(payload)=>payload as {a:number;b:number}
  }),/Unsupported adaptive state version/);
});

function node(id:string,scope:'target'|'action'|'subgoal'|'task'|'environment',state:'ACTIVE'|'SUPPORTED'|'DISPROVEN'|'RESOLVED',confidence:number,updatedAt:string):HypothesisNode{
  return{
    id,scope,class:'UNKNOWN',statement:id,confidence,state,
    evidence:[],contradictingEvidence:[],createdAt:T0,updatedAt
  };
}

test('hypothesis pruning expires old resolved/disproven state and respects global/scope caps',()=>{
  const nodes:HypothesisNode[]=[
    node('active-task','task','ACTIVE',0.8,'2026-10-05T00:59:00.000Z'),
    node('active-target-1','target','ACTIVE',0.9,'2026-10-05T00:59:00.000Z'),
    node('active-target-2','target','ACTIVE',0.7,'2026-10-05T00:58:00.000Z'),
    node('old-resolved','task','RESOLVED',1,'2026-10-03T00:00:00.000Z'),
    node('old-disproven','environment','DISPROVEN',1,'2026-10-04T00:00:00.000Z')
  ];
  const result=pruneHypotheses(nodes,{maxTotal:3,maxPerScope:1,resolvedTtlMs:60_000,disprovenTtlMs:60_000},{now:new Date('2026-10-05T01:00:00.000Z')});
  assert.ok(result.prunedIds.includes('old-resolved'));
  assert.ok(result.prunedIds.includes('old-disproven'));
  assert.equal(result.retained.filter(n=>n.scope==='target').length,1);
  assert.ok(result.retained.length<=3);
});

test('shadow/control comparison measures divergence and verified outcome delta',()=>{
  const log=new DecisionTraceLog({clock:()=>new Date(T0)});
  const shadow=log.append({
    mode:'SHADOW',kind:'STRATEGY',taskId:'t1',policyVersion:'p1',selectedId:'keyboard',
    alternatives:['pointer'],reason:'avoid repeated failure',evidence:[],authoritySnapshotDigest:A,inputStateDigest:B
  });
  const control=log.append({
    mode:'CONTROL',kind:'STRATEGY',taskId:'t1',policyVersion:'p1',selectedId:'pointer',
    alternatives:['keyboard'],reason:'current production choice',evidence:[],authoritySnapshotDigest:A,inputStateDigest:B
  });
  const report=compareShadowToControl(log.recent(10),[
    {taskId:'t1',decisionDigest:shadow.decisionDigest,verifiedSuccess:true,progressScore:1,cost:1},
    {taskId:'t1',decisionDigest:control.decisionDigest,verifiedSuccess:false,progressScore:0,cost:2}
  ]);
  assert.equal(report.pairedDecisions,1);
  assert.equal(report.divergenceRate,1);
  assert.equal(report.shadowWinRate,1);
  assert.equal(report.meanShadowProgressDelta,1);
  assert.equal(report.meanShadowCostDelta,-1);
});

test('promotion ledger rejects receipt replay for a different skill fingerprint',()=>{
  const ledger=new PromotionLedger({clock:()=>new Date(T0)});
  ledger.record({
    skillId:'skill-a',
    promoted:true,
    reason:'verified',
    verificationDigests:[A],
    policyVersion:'p1',
    sourceRunIds:['run-1']
  },B);

  assert.throws(()=>ledger.record({
    skillId:'skill-b',
    promoted:true,
    reason:'verified',
    verificationDigests:[A],
    policyVersion:'p1',
    sourceRunIds:['run-2']
  },C),/Verification receipt replay/);

  assert.throws(()=>ledger.record({
    skillId:'skill-c',
    promoted:true,
    reason:'verified',
    verificationDigests:[D],
    policyVersion:'p1',
    sourceRunIds:['run-1']
  },C),/Source run cannot promote conflicting/);
});
