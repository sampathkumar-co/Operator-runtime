import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CausalGraph,
  assessOutcomeContract,
  deriveDelta,
  selectStrategy
} from '../src/index.ts';
import type { BeliefResolution, StrategyCandidate } from '../src/index.ts';
import { SyntheticEnvironment } from './synthetic-environment.ts';

const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),D='d'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';
function ev(digest:string,source='semantic'){return{digest,source,observedAt:T0};}

test('generic outcome contract requires independent fresh evidence and rejects forbidden facts',()=>{
  const beliefs:BeliefResolution[]=[
    {
      factKey:'document.saved',
      status:'KNOWN',
      confidence:0.96,
      selectedValueDigest:A,
      supportingEvidence:[ev(A,'dom'),ev(B,'application')],
      contradictingEvidence:[],
      staleEvidence:[],
      alternatives:[{valueDigest:A,confidence:0.96}],
      updatedAt:T0
    },
    {
      factKey:'dialog.error',
      status:'UNKNOWN',
      confidence:0,
      supportingEvidence:[],
      contradictingEvidence:[],
      staleEvidence:[],
      alternatives:[],
      updatedAt:T0
    }
  ];
  const result=assessOutcomeContract({
    id:'save-contract',
    required:[{
      factKey:'document.saved',
      expectedValueDigest:A,
      minConfidence:0.9,
      minIndependentSources:2,
      maxEvidenceAgeMs:60_000
    }],
    forbidden:[{factKey:'dialog.error',minConfidence:0.7}]
  },beliefs,{now:new Date('2026-10-05T00:00:10.000Z')});
  assert.equal(result.ok,true);
  assert.deepEqual(result.unresolvedFacts,[]);
});

test('outcome contract fails closed when evidence is stale or single-source',()=>{
  const beliefs:BeliefResolution[]=[{
    factKey:'document.saved',
    status:'KNOWN',
    confidence:0.99,
    selectedValueDigest:A,
    supportingEvidence:[ev(A,'dom')],
    contradictingEvidence:[],
    staleEvidence:[],
    alternatives:[{valueDigest:A,confidence:0.99}],
    updatedAt:T0
  }];
  const result=assessOutcomeContract({
    id:'strict',
    required:[{factKey:'document.saved',minIndependentSources:2,maxEvidenceAgeMs:1000}]
  },beliefs,{now:new Date('2026-10-05T00:00:10.000Z')});
  assert.equal(result.ok,false);
});

test('metamorphic irrelevant mutations never satisfy the expected goal effect across 100 variants',()=>{
  for(let i=0;i<100;i+=1){
    const env=new SyntheticEnvironment({facts:{'goal.saved':A,'noise.0':B}});
    const step=env.run({
      action:{
        id:'a'+i,
        family:'semantic-invoke',
        capability:'ui.interact',
        risk:'write',
        expectedEffects:['goal.saved']
      },
      externalMutations:{['noise.'+(i+1)]:i%2===0?C:D}
    });
    const delta=deriveDelta(step.before,step.after,['goal.saved'],[]);
    assert.deepEqual(delta.expectedEffectsSatisfied,[]);
    assert.deepEqual(delta.expectedEffectsMissing,['goal.saved']);
  }
});

test('anti-loop strategy choice is invariant to superficial target labels when failure family/effect is the same',()=>{
  const graph=new CausalGraph({clock:()=>new Date(T0)});
  for(const target of ['Save','Submit','Confirm']){
    const env=new SyntheticEnvironment({facts:{'goal.done':A}});
    const step=env.run({
      action:{
        id:'action-'+target,
        family:'pointer-activation',
        capability:'ui.interact',
        risk:'write',
        semanticTarget:target,
        expectedEffects:['goal.done']
      },
      outcome:{ok:false,errorCode:'NO_PROGRESS',sideEffectState:'none',executionPhase:'effect_observed'}
    });
    graph.record(step);
  }
  const candidates:StrategyCandidate[]=[
    {
      id:'pointer-again',
      family:'pointer-activation',
      description:'try another pointer activation',
      expectedSuccess:0.86,
      expectedCost:1,
      uncertainty:0.1,
      verificationStrength:0.8,
      expectedEffects:['goal.done']
    },
    {
      id:'semantic-keyboard',
      family:'keyboard-semantic-navigation',
      description:'use a different interaction family',
      expectedSuccess:0.7,
      expectedCost:1,
      uncertainty:0.1,
      verificationStrength:0.8,
      expectedEffects:['goal.done']
    }
  ];
  const result=selectStrategy({candidates,recentTransitions:graph.recent(10).reverse()});
  assert.equal(result.selected.id,'semantic-keyboard');
});
