import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCounterfactualPlans } from '../src/index.ts';

const ops=[
  {id:'direct-risky',requires:['start'],adds:['done'],removes:[],expectedSuccess:.95,expectedInformationGain:.1,expectedCost:1,risk:.9,verificationStrength:.3,reversible:false},
  {id:'safe-observe',requires:['start'],adds:['ready'],removes:[],expectedSuccess:.99,expectedInformationGain:.8,expectedCost:1,risk:.01,verificationStrength:.8,reversible:true},
  {id:'safe-act',requires:['ready'],adds:['done'],removes:[],expectedSuccess:.9,expectedInformationGain:.1,expectedCost:2,risk:.05,verificationStrength:.95,reversible:true},
  {id:'bad-side-effect',requires:['start'],adds:['done','forbidden'],removes:[],expectedSuccess:1,expectedInformationGain:.1,expectedCost:1,risk:.01,verificationStrength:1,reversible:true}
];

test('counterfactual search finds a safe multi-step path when direct action exceeds risk limit',()=>{
  const plans=searchCounterfactualPlans({facts:['start']},ops,['done'],['forbidden'],{
    maxDepth:4,beamWidth:10,maximumRisk:.2
  });
  assert.equal(plans[0]?.goalSatisfied,true);
  assert.deepEqual(plans[0]?.candidate.nodeIds,['safe-observe','safe-act']);
  assert.ok((plans[0]?.candidate.risk??1)<.2);
});

test('lookahead never returns a goal path that violates forbidden facts',()=>{
  const plans=searchCounterfactualPlans({facts:['start']},ops,['done'],['forbidden'],{
    maxDepth:3,maximumRisk:1
  });
  assert.equal(plans.some(p=>p.resultingFacts.includes('forbidden')),false);
});

test('lookahead obeys hard budget before considering utility',()=>{
  const plans=searchCounterfactualPlans({facts:['start']},ops.filter(o=>o.id!=='direct-risky'),['done'],['forbidden'],{
    maxDepth:3,remainingCostBudget:1.5,maximumRisk:.2
  });
  assert.equal(plans.some(p=>p.goalSatisfied),false);
});

test('lookahead deduplicates state loops rather than consuming the entire expansion budget',()=>{
  const loop={id:'loop',requires:['start'],adds:['start'],removes:[],expectedSuccess:1,expectedInformationGain:0,expectedCost:.1,risk:0,verificationStrength:.1,reversible:true};
  const finish={id:'finish',requires:['start'],adds:['done'],removes:[],expectedSuccess:.9,expectedInformationGain:.1,expectedCost:1,risk:0,verificationStrength:.9,reversible:true};
  const plans=searchCounterfactualPlans({facts:['start']},[loop,finish],['done'],[],{maxDepth:10,maximumExpandedStates:10});
  assert.equal(plans[0]?.goalSatisfied,true);
  assert.deepEqual(plans[0]?.candidate.nodeIds,['finish']);
});
