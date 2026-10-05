import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CausalGraph,
  compressTrajectory,
  selectObservation,
  selectStrategy
} from '../src/index.ts';
import type { BeliefResolution, TrajectoryStep } from '../src/index.ts';

const A='a'.repeat(64),B='b'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';

test('strategy selection treats zero remaining budget as a hard boundary',()=>{
  assert.throws(()=>selectStrategy({
    remainingCostBudget:0,
    candidates:[{
      id:'costly',
      family:'semantic',
      description:'costly',
      expectedSuccess:0.9,
      expectedCost:1,
      uncertainty:0.1,
      verificationStrength:0.9
    }]
  }),/fits the remaining cost budget/);

  const result=selectStrategy({
    remainingCostBudget:0,
    candidates:[{
      id:'free',
      family:'read-cache',
      description:'free cached read',
      expectedSuccess:0.8,
      expectedCost:0,
      uncertainty:0.1,
      verificationStrength:0.8
    }]
  });
  assert.equal(result.selected.id,'free');
});

test('observation selection treats zero remaining budget as a hard boundary',()=>{
  const beliefs:BeliefResolution[]=[{
    factKey:'target.identity',
    status:'UNKNOWN',
    confidence:0,
    supportingEvidence:[],
    contradictingEvidence:[],
    staleEvidence:[],
    alternatives:[],
    updatedAt:T0
  }];

  assert.throws(()=>selectObservation(beliefs,[{
    id:'costly',
    channel:'dom',
    description:'inspect',
    resolvesFacts:['target.identity'],
    expectedInformationGain:1,
    expectedCost:1,
    targetLocal:true
  }],{remainingCostBudget:0}),/fits the remaining cost budget/);

  assert.equal(selectObservation(beliefs,[{
    id:'cached',
    channel:'runtime',
    description:'use already materialized read-only state',
    resolvesFacts:['target.identity'],
    expectedInformationGain:0.6,
    expectedCost:0,
    targetLocal:true
  }],{remainingCostBudget:0}).selected.id,'cached');
});

test('same action family with a different intended effect is not an equivalent failure loop',()=>{
  const graph=new CausalGraph({clock:()=>new Date(T0)});
  graph.record({
    before:{id:'b',observedAt:T0,scopeKey:'scene',facts:[{key:'left.changed',valueDigest:A,confidence:1,evidence:[]}]},
    action:{id:'a',family:'pointer',capability:'ui.interact',risk:'write',expectedEffects:['left.changed']},
    outcome:{ok:false,sideEffectState:'none',executionPhase:'effect_observed',evidence:[]},
    after:{id:'c',observedAt:T0,scopeKey:'scene',facts:[{key:'left.changed',valueDigest:A,confidence:1,evidence:[]}]}
  });

  const result=selectStrategy({
    recentTransitions:graph.recent(10).reverse(),
    candidates:[
      {
        id:'new-pointer-goal',
        family:'pointer',
        description:'use pointer for a different target effect',
        expectedSuccess:0.9,
        expectedCost:1,
        uncertainty:0.1,
        verificationStrength:0.9,
        expectedEffects:['right.changed']
      },
      {
        id:'keyboard',
        family:'keyboard',
        description:'keyboard alternative',
        expectedSuccess:0.55,
        expectedCost:1,
        uncertainty:0.1,
        verificationStrength:0.9,
        expectedEffects:['right.changed']
      }
    ]
  });
  assert.equal(result.selected.id,'new-pointer-goal');
  assert.equal(result.selected.repeatedEquivalentFailures,0);
});

function step(index:number,effect:string,level:TrajectoryStep['progress']['level'],failed:boolean):TrajectoryStep{
  return{
    index,
    action:{id:'a'+index,family:'pointer',capability:'ui',risk:'write',expectedEffects:[effect]},
    outcome:{ok:!failed,sideEffectState:failed?'none':'known',executionPhase:'effect_observed',evidence:[]},
    delta:{
      changedFactKeys:failed?[]:[effect],
      addedFactKeys:[],removedFactKeys:[],
      expectedEffectsSatisfied:failed?[]:[effect],
      expectedEffectsMissing:failed?[effect]:[],
      unrelatedEffects:[],progressSignals:[]
    },
    progress:{
      level,
      confidence:level==='GOAL_ACHIEVED'?0.95:0,
      creditedSignals:[],rejectedSignals:[],
      goalFactsSatisfied:[],goalFactsMissing:[],
      forbiddenFactsObserved:[],verificationRequired:level!=='GOAL_ACHIEVED'
    },
    ...(failed?{failure:{
      primary:{class:'ACTION_NO_EFFECT',probability:1,reasons:['failed'],evidence:[]},
      alternatives:[],entropy:0,evidenceCoverage:1
    }}:{})
  };
}

test('trajectory compression reports current progress, not highest historical progress',()=>{
  const compressed=compressTrajectory({
    goal:{id:'g',kind:'stateful',objective:'stay complete',successFactKeys:['goal.done']},
    beliefs:[],
    steps:[
      step(0,'goal.done','GOAL_ACHIEVED',false),
      step(1,'goal.still-valid','NONE',true)
    ]
  });
  assert.equal(compressed.progressLevel,'NONE');
});

test('trajectory compression does not call unrelated same-family failures a repeated failure family',()=>{
  const compressed=compressTrajectory({
    goal:{id:'g',kind:'multi-target',objective:'change both',successFactKeys:['goal.done']},
    beliefs:[],
    steps:[
      step(0,'left.changed','NONE',true),
      step(1,'right.changed','NONE',true)
    ]
  });
  assert.deepEqual(compressed.repeatedFailureFamilies,[]);
});
