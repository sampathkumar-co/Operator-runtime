import assert from 'node:assert/strict';
import test from 'node:test';
import { LearningFirewall } from '../src/index.ts';
import type { SkillDraft } from '../src/index.ts';

const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),D='d'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';

function skill(overrides:Partial<SkillDraft>={}):SkillDraft{
  return{
    id:'generic-skill',
    objectiveKind:'generic-navigation',
    title:'Navigate dynamic hierarchy safely',
    scopeClass:'authorized-ui',
    assumptions:['semantic state available'],
    steps:[{
      actionFamily:'discover-descendants',
      capability:'ui.observe',
      preconditions:['parent visible'],
      expectedEffects:['child visible'],
      verificationFacts:['child actionable']
    }],
    verificationDigests:[A],
    sourceRunIds:['run-1'],
    ...overrides
  };
}
function receipt(overrides:Record<string,unknown>={}){
  return{
    digest:A,
    goalId:'goal-1',
    verifierId:'verification-kernel',
    verifiedAt:T0,
    authoritySnapshotDigest:B,
    sourceRunId:'run-1',
    ...overrides
  } as any;
}

test('learning promotion requires authoritative receipt references instead of a self asserted boolean',()=>{
  const firewall=new LearningFirewall({clock:()=>new Date(T0)});
  const result=firewall.evaluate({
    skill:skill(),
    mode:'NORMAL',
    policyVersion:'p1',
    verificationReceipts:[]
  });
  assert.equal(result.promoted,false);
  assert.match(result.reason,/verification receipt/i);
});

test('verification receipt digest set must exactly match skill proof set',()=>{
  const firewall=new LearningFirewall({clock:()=>new Date(T0)});
  const result=firewall.evaluate({
    skill:skill(),
    mode:'NORMAL',
    policyVersion:'p1',
    verificationReceipts:[receipt({digest:C})]
  });
  assert.equal(result.promoted,false);
  assert.match(result.reason,/digests do not exactly match/i);
});

test('verification receipt source-run set must exactly match skill source lineage',()=>{
  const firewall=new LearningFirewall({clock:()=>new Date(T0)});
  const result=firewall.evaluate({
    skill:skill(),
    mode:'NORMAL',
    policyVersion:'p1',
    verificationReceipts:[receipt({sourceRunId:'other-run'})]
  });
  assert.equal(result.promoted,false);
  assert.match(result.reason,/source runs do not exactly match/i);
});

test('future-dated learning verification receipts fail closed',()=>{
  const firewall=new LearningFirewall({clock:()=>new Date(T0)});
  assert.throws(()=>firewall.evaluate({
    skill:skill(),
    mode:'NORMAL',
    policyVersion:'p1',
    verificationReceipts:[receipt({verifiedAt:'2026-10-05T00:00:01.000Z'})]
  }),/future-dated/);
});

test('all declared verification proofs and source runs must be covered before promotion',()=>{
  const firewall=new LearningFirewall({clock:()=>new Date(T0)});
  const multi=skill({
    verificationDigests:[A,C],
    sourceRunIds:['run-1','run-2']
  });

  const partial=firewall.evaluate({
    skill:multi,
    mode:'NORMAL',
    policyVersion:'p1',
    verificationReceipts:[receipt()]
  });
  assert.equal(partial.promoted,false);

  const complete=new LearningFirewall({clock:()=>new Date(T0)}).evaluate({
    skill:multi,
    mode:'NORMAL',
    policyVersion:'p1',
    verificationReceipts:[
      receipt(),
      receipt({digest:C,sourceRunId:'run-2',authoritySnapshotDigest:D})
    ]
  });
  assert.equal(complete.promoted,true);
});

test('duplicate receipt identity is rejected instead of silently inflating proof',()=>{
  const firewall=new LearningFirewall({clock:()=>new Date(T0)});
  assert.throws(()=>firewall.evaluate({
    skill:skill(),
    mode:'NORMAL',
    policyVersion:'p1',
    verificationReceipts:[receipt(),receipt()]
  }),/Duplicate learning verification receipt/);
});
