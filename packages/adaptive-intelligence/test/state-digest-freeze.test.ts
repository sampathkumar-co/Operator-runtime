import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AdaptiveIntelligenceKernel,
  createEvaluationFreezeManifest,
  decodeVersionedState,
  encodeVersionedState,
  sameEvaluationCandidate
} from '../src/index.ts';

const T0='2026-10-05T00:00:00.000Z';
const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),D='d'.repeat(64);

function freeze(adaptiveStateDigest:string){
  return createEvaluationFreezeManifest({
    sourceRevision:'abcdef1',
    intelligencePolicyVersion:'adaptive-v1',
    intelligencePolicyDigest:A,
    adaptiveStateDigest,
    authorityPolicyDigest:B,
    procedureSnapshotDigest:C,
    modelProvider:'provider',
    modelId:'model',
    modelConfigDigest:D,
    environmentId:'env',
    environmentDigest:A,
    runnerDigest:B,
    benchmarkId:'suite',
    benchmarkDigest:C,
    seed:0
  },{clock:()=>new Date(T0)});
}

test('kernel state digest is deterministic across exact restart',()=>{
  const one=new AdaptiveIntelligenceKernel({clock:()=>new Date(T0)});
  one.observeBelief({
    factKey:'target.visible',
    valueDigest:A,
    polarity:'supports',
    confidence:0.9,
    evidence:{
      digest:B,
      source:'dom',
      channel:'dom',
      observedAt:T0,
      independenceKey:'dom-1'
    }
  });
  const state=one.exportState();
  const two=AdaptiveIntelligenceKernel.fromState(state,{clock:()=>new Date(T0)});
  assert.equal(two.stateDigest(),one.stateDigest());
  assert.match(one.stateDigest(),/^[0-9a-f]{64}$/);
});

test('kernel state digest changes when adaptive state changes',()=>{
  const kernel=new AdaptiveIntelligenceKernel({clock:()=>new Date(T0)});
  const before=kernel.stateDigest();
  kernel.observeBelief({
    factKey:'target.visible',
    valueDigest:A,
    polarity:'supports',
    confidence:0.9,
    evidence:{digest:B,source:'dom',observedAt:T0}
  });
  const after=kernel.stateDigest();
  assert.notEqual(after,before);
});

test('evaluation freeze candidate identity binds exact adaptive kernel state',()=>{
  const one=new AdaptiveIntelligenceKernel({clock:()=>new Date(T0)});
  const baseline=freeze(one.stateDigest());

  const two=AdaptiveIntelligenceKernel.fromState(one.exportState(),{clock:()=>new Date(T0)});
  const equivalent=freeze(two.stateDigest());
  assert.equal(sameEvaluationCandidate(baseline,equivalent),true);

  two.observeBelief({
    factKey:'new.fact',
    valueDigest:A,
    polarity:'supports',
    confidence:0.8,
    evidence:{digest:B,source:'runtime',observedAt:T0}
  });
  const changed=freeze(two.stateDigest());
  assert.equal(sameEvaluationCandidate(baseline,changed),false);
});

test('future-dated durable envelope fails closed by default',()=>{
  const envelope=encodeVersionedState('test',{value:1},{
    clock:()=>new Date('2026-10-05T00:00:10.000Z')
  });
  assert.throws(()=>decodeVersionedState(envelope,{
    kind:'test',
    now:new Date(T0),
    validate:(payload)=>payload as {value:number}
  }),/future-dated/);
});

test('explicit bounded clock skew may admit a future envelope within allowance',()=>{
  const envelope=encodeVersionedState('test',{value:1},{
    clock:()=>new Date('2026-10-05T00:00:01.000Z')
  });
  const decoded=decodeVersionedState(envelope,{
    kind:'test',
    now:new Date(T0),
    maxFutureSkewMs:1000,
    validate:(payload)=>payload as {value:number}
  });
  assert.deepEqual(decoded.payload,{value:1});
});
