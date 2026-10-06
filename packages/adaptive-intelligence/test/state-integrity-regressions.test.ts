import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PromotionLedger,
  canonicalJson,
  encodeVersionedState,
  pruneHypotheses
} from '../src/index.ts';
import type { HypothesisNode, LearningReceipt } from '../src/index.ts';

const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),D='d'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';

function node(input:Partial<HypothesisNode>&Pick<HypothesisNode,'id'|'scope'|'state'|'confidence'>):HypothesisNode{
  return{
    class:'UNKNOWN',
    statement:input.id,
    evidence:[],
    contradictingEvidence:[],
    createdAt:T0,
    updatedAt:T0,
    ...input
  };
}

test('pruning never leaves a live retained dependency dangling after caps remove its prerequisite',()=>{
  const nodes:HypothesisNode[]=[
    node({
      id:'dependency',
      scope:'action',
      state:'ACTIVE',
      confidence:0.1
    }),
    node({
      id:'dependent',
      scope:'task',
      state:'ACTIVE',
      confidence:0.99,
      dependsOn:['dependency']
    })
  ];

  const result=pruneHypotheses(nodes,{maxTotal:1,maxPerScope:1},{now:new Date(T0)});
  const retainedIds=new Set(result.retained.map(item=>item.id));

  for(const retained of result.retained){
    for(const dependency of retained.dependsOn??[]){
      assert.ok(retainedIds.has(dependency),'retained dependency must exist: '+dependency);
    }
    if(retained.parentId) assert.ok(retainedIds.has(retained.parentId),'retained parent must exist');
  }
  assert.ok(result.prunedIds.includes('dependent'));
  assert.equal(result.reasonById['dependent'],'dependency-pruned');
});

test('pruning elides terminal dependency references rather than leaving corrupt snapshots',()=>{
  const nodes:HypothesisNode[]=[
    node({
      id:'resolved-prerequisite',
      scope:'action',
      state:'RESOLVED',
      confidence:1,
      updatedAt:'2026-10-01T00:00:00.000Z'
    }),
    node({
      id:'active-child',
      scope:'task',
      state:'ACTIVE',
      confidence:0.9,
      dependsOn:['resolved-prerequisite']
    })
  ];

  const result=pruneHypotheses(nodes,{
    maxTotal:5,
    maxPerScope:5,
    resolvedTtlMs:1
  },{now:new Date('2026-10-05T00:00:00.000Z')});

  const child=result.retained.find(item=>item.id==='active-child');
  assert.ok(child);
  assert.equal(child?.dependsOn,undefined);
  assert.ok(result.prunedIds.includes('resolved-prerequisite'));
});

test('canonical durable serialization rejects cyclic and non-plain objects fail closed',()=>{
  const cyclic:Record<string,unknown>={a:1};
  cyclic.self=cyclic;
  assert.throws(()=>canonicalJson(cyclic),/Cyclic adaptive state/);
  assert.throws(()=>canonicalJson(new Date(T0)),/plain JSON objects/);
  assert.throws(()=>canonicalJson(new Map([['a',1]])),/plain JSON objects/);
  assert.throws(()=>canonicalJson({x:undefined}),/Unsupported value/);
});

test('canonical durable serialization is key-order invariant and allows repeated non-cyclic references',()=>{
  const shared={x:1,y:2};
  const first=canonicalJson({b:shared,a:{z:3},c:shared});
  const second=canonicalJson({c:{y:2,x:1},a:{z:3},b:{y:2,x:1}});
  assert.equal(first,second);
  const envelope=encodeVersionedState('safe',{b:shared,c:shared},{clock:()=>new Date(T0)});
  assert.match(envelope.payloadDigest,/^[0-9a-f]{64}$/);
});

function receipt(skillId:string,digest:string,runId:string):LearningReceipt{
  return{
    skillId,
    promoted:true,
    reason:'verified',
    verificationDigests:[digest],
    policyVersion:'p1',
    sourceRunIds:[runId]
  };
}

test('promotion ledger prevents semantic rebinding of an existing skill id',()=>{
  const ledger=new PromotionLedger({clock:()=>new Date(T0)});
  ledger.record(receipt('stable-skill',A,'run-a'),B);

  assert.throws(
    ()=>ledger.record(receipt('stable-skill',C,'run-c'),D),
    /Skill id cannot be rebound/
  );
  assert.equal(ledger.fingerprintForSkill('stable-skill'),B);
});

test('promotion ledger prevents aliasing one semantic fingerprint under multiple skill ids',()=>{
  const ledger=new PromotionLedger({clock:()=>new Date(T0)});
  ledger.record(receipt('canonical-skill',A,'run-a'),B);

  assert.throws(
    ()=>ledger.record(receipt('alias-skill',C,'run-c'),B),
    /fingerprint cannot be aliased/
  );
});
