import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADAPTIVE_STATE_VERSION,
  DecisionTraceLog,
  HypothesisGraph,
  PromotionLedger,
  decodeVersionedState,
  encodeVersionedState
} from '../src/index.ts';
import type { HypothesisNode, LearningReceipt } from '../src/index.ts';

const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),D='d'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';

test('v2 durable envelope binds metadata as well as payload',()=>{
  const envelope=encodeVersionedState('hypotheses',{value:1},{clock:()=>new Date(T0)});
  assert.equal(envelope.version,ADAPTIVE_STATE_VERSION);
  assert.equal(ADAPTIVE_STATE_VERSION,2);
  assert.match(envelope.envelopeDigest,/^[0-9a-f]{64}$/);

  assert.throws(()=>decodeVersionedState({
    ...envelope,
    createdAt:'2026-10-05T00:00:01.000Z'
  },{
    kind:'hypotheses',
    validate:(payload)=>payload as {value:number}
  }),/metadata digest mismatch/);
});

test('legacy envelope version cannot be silently accepted without migration',()=>{
  const envelope=encodeVersionedState('state',{value:1},{clock:()=>new Date(T0)});
  assert.throws(()=>decodeVersionedState({
    ...envelope,
    version:1
  },{
    kind:'state',
    acceptedVersions:[1,2],
    validate:(payload)=>payload as {value:number}
  }),/explicit migration/);
});

function hypothesis(id:string,extra:Partial<HypothesisNode>={}):HypothesisNode{
  return{
    id,
    scope:'task',
    class:'UNKNOWN',
    statement:id,
    confidence:0.8,
    state:'ACTIVE',
    evidence:[],
    contradictingEvidence:[],
    createdAt:T0,
    updatedAt:T0,
    ...extra
  };
}

test('hypothesis graph snapshot round-trips without losing hierarchy/dependencies',()=>{
  const original=HypothesisGraph.fromSnapshot([
    hypothesis('root'),
    hypothesis('dependency',{scope:'action'}),
    hypothesis('child',{scope:'target',parentId:'root',dependsOn:['dependency']})
  ],{clock:()=>new Date(T0)});

  const restored=HypothesisGraph.fromSnapshot(original.snapshot(),{clock:()=>new Date(T0)});
  assert.deepEqual(restored.snapshot(),original.snapshot());
  assert.deepEqual(restored.unresolvedDependencies('child').map(item=>item.id),['dependency']);
});

test('hypothesis graph rejects corrupted snapshots with dangling refs or cycles',()=>{
  assert.throws(()=>HypothesisGraph.fromSnapshot([
    hypothesis('child',{dependsOn:['missing']})
  ]),/dangling dependency/);

  assert.throws(()=>HypothesisGraph.fromSnapshot([
    hypothesis('a',{dependsOn:['b']}),
    hypothesis('b',{dependsOn:['a']})
  ]),/cycle/);
});

function decisionInput(){
  return{
    mode:'SHADOW' as const,
    kind:'STRATEGY' as const,
    runId:'run-1',
    taskId:'task-1',
    goalId:'goal-1',
    policyVersion:'policy-1',
    decisionPointId:'step-7',
    selectedId:'keyboard',
    alternatives:['pointer'],
    reason:'avoid repeated equivalent failure',
    evidence:[],
    authoritySnapshotDigest:A,
    inputStateDigest:B
  };
}

test('repeated identical decisions get unique attributable digests',()=>{
  const log=new DecisionTraceLog({clock:()=>new Date(T0)});
  const one=log.append(decisionInput());
  const two=log.append(decisionInput());
  assert.notEqual(one.id,two.id);
  assert.notEqual(one.decisionDigest,two.decisionDigest);
});

test('decision trace snapshot round-trips and rejects altered records',()=>{
  const log=new DecisionTraceLog({clock:()=>new Date(T0)});
  log.append(decisionInput());
  const snapshot=log.snapshot();
  const restored=DecisionTraceLog.fromSnapshot(snapshot,{clock:()=>new Date(T0)});
  assert.deepEqual(restored.snapshot(),snapshot);

  const corrupted=structuredClone(snapshot);
  corrupted[0]!.reason='tampered after persistence';
  assert.throws(()=>DecisionTraceLog.fromSnapshot(corrupted),/digest mismatch/);
});

function receipt(skillId:string,verificationDigest:string,runId:string):LearningReceipt{
  return{
    skillId,
    promoted:true,
    reason:'verified',
    verificationDigests:[verificationDigest],
    policyVersion:'p1',
    sourceRunIds:[runId]
  };
}

test('promotion ledger snapshot round-trips with replay ownership intact',()=>{
  const ledger=new PromotionLedger({clock:()=>new Date(T0)});
  ledger.record(receipt('skill-a',A,'run-a'),B);
  ledger.record(receipt('skill-a',C,'run-c'),B);
  const snapshot=ledger.snapshot();

  const restored=PromotionLedger.fromSnapshot(snapshot,{clock:()=>new Date(T0)});
  assert.deepEqual(restored.snapshot(),snapshot);
  assert.equal(restored.verificationOwner(A),B);
  assert.equal(restored.fingerprintForSkill('skill-a'),B);

  assert.throws(()=>restored.record(receipt('skill-other',D,'run-other'),B),/aliased/);
});

test('promotion ledger rehydration rejects modified persisted claims',()=>{
  const ledger=new PromotionLedger({clock:()=>new Date(T0)});
  ledger.record(receipt('skill-a',A,'run-a'),B);
  const snapshot=ledger.snapshot();
  const corrupted=structuredClone(snapshot);
  corrupted[0]!.policyVersion='tampered-policy';
  assert.throws(()=>PromotionLedger.fromSnapshot(corrupted),/claim digest mismatch/);
});
