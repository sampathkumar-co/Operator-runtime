import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CalibrationTracker,
  CausalGraph,
  EpistemicStateEngine,
  HypothesisGraph,
  LearningFirewall,
  assessPolicyPromotion,
  selectStrategy
} from '../src/index.ts';

const A='a'.repeat(64),B='b'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';

test('epistemic confidence rejects numeric strings instead of coercing',()=>{
  const engine=new EpistemicStateEngine({clock:()=>new Date(T0)});
  assert.throws(()=>engine.observe({
    factKey:'target.visible',
    valueDigest:A,
    polarity:'supports',
    confidence:'0.9' as any,
    evidence:{digest:B,source:'test',observedAt:T0}
  }),/must be a number/);
});

test('causal snapshot ids reject non-string runtime values',()=>{
  const graph=new CausalGraph({clock:()=>new Date(T0)});
  assert.throws(()=>graph.record({
    before:{id:123 as any,observedAt:T0,scopeKey:'scene',facts:[]},
    action:{id:'a',family:'read',capability:'observe',risk:'read'},
    outcome:{ok:true,evidence:[]},
    after:{id:'after',observedAt:T0,scopeKey:'scene',facts:[]}
  }),/must be a string/);
});

test('strategy expected success rejects numeric strings',()=>{
  assert.throws(()=>selectStrategy({
    candidates:[{
      id:'s1',
      family:'semantic',
      description:'candidate',
      expectedSuccess:'0.9' as any,
      expectedCost:1,
      uncertainty:0.1,
      verificationStrength:0.9
    }]
  }),/must be a number/);
});

test('hypothesis state/scope reject non-string runtime values',()=>{
  const graph=new HypothesisGraph({clock:()=>new Date(T0)});
  assert.throws(()=>graph.add({
    id:'h1',
    scope:1 as any,
    class:'UNKNOWN',
    statement:'bad',
    confidence:0.5
  }),/scope must be a string/);
});

test('calibration predictions reject numeric strings',()=>{
  const tracker=new CalibrationTracker();
  assert.throws(()=>tracker.record({
    prediction:'0.8' as any,
    outcome:1
  }),/must be a number/);
});

test('learning policy version rejects object-to-string coercion',()=>{
  const firewall=new LearningFirewall({clock:()=>new Date(T0)});
  assert.throws(()=>firewall.evaluate({
    skill:{
      id:'skill',
      objectiveKind:'generic',
      title:'Generic',
      scopeClass:'ui',
      assumptions:[],
      steps:[{
        actionFamily:'observe',
        capability:'ui.observe',
        preconditions:[],
        expectedEffects:['x'],
        verificationFacts:['x']
      }],
      verificationDigests:[A],
      sourceRunIds:['run-1']
    },
    mode:'NORMAL',
    policyVersion:{toString:()=> 'p1'} as any,
    verificationReceipts:[{
      digest:A,
      goalId:'g1',
      verifierId:'verification-kernel',
      verifiedAt:T0,
      authoritySnapshotDigest:B,
      sourceRunId:'run-1'
    }]
  }),/must be a string/);
});
