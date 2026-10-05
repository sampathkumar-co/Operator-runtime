import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindPlanToBeliefs, compileExecution, initializeNodeStates, rankPlanBranches, validatePlanGraph
} from '../src/index.ts';
import { belief, goal, graph } from './fixtures.ts';

test('belief contradiction invalidates dependent plan cone but not prior success',()=>{
  const p=validatePlanGraph(goal(),graph());
  const states=initializeNodeStates(p,'2026-10-05T10:00:00.000Z');
  states[0]!.status='SUCCEEDED';
  states[1]!.status='READY';
  const out=bindPlanToBeliefs(p,states,[belief('state.observed','DISPROVEN')],'2026-10-05T10:01:00.000Z');
  assert.deepEqual(out.invalidatedNodeIds,['act','verify']);
  assert.equal(out.states.find(s=>s.nodeId==='observe')?.status,'SUCCEEDED');
  assert.equal(out.states.find(s=>s.nodeId==='act')?.status,'INVALIDATED');
});

test('branch search favors verified low-risk alternatives over superficially high-success risky branch',()=>{
  const ranked=rankPlanBranches([
    {id:'risky',nodeIds:['a'],expectedSuccess:.95,expectedInformationGain:.1,expectedCost:2,risk:.95,uncertainty:.3,verificationStrength:.2,reversibleFraction:0},
    {id:'safe',nodeIds:['b','c'],expectedSuccess:.8,expectedInformationGain:.3,expectedCost:3,risk:.1,uncertainty:.1,verificationStrength:.95,reversibleFraction:1}
  ]);
  assert.equal(ranked[0]?.id,'safe');
});

test('branch search enforces hard cost and risk budgets',()=>{
  assert.throws(()=>rankPlanBranches([
    {id:'a',nodeIds:['a'],expectedSuccess:.9,expectedInformationGain:.1,expectedCost:100,risk:.9,uncertainty:.1,verificationStrength:.9,reversibleFraction:1}
  ],{remainingCostBudget:2,maximumRisk:.2}),/no plan branch/);
});

test('execution compiler chooses structured safe execution over uncertain GUI',()=>{
  const node=graph().nodes[1]!;
  const ranked=compileExecution(node,[
    {id:'gui',modality:'GUI',capability:'browser.write',expectedSuccess:.72,expectedCost:2,uncertainty:.4,verificationStrength:.5,mutating:true,supportsRollback:true},
    {id:'pw',modality:'PLAYWRIGHT',capability:'browser.write',expectedSuccess:.82,expectedCost:2,uncertainty:.1,verificationStrength:.9,mutating:true,supportsRollback:true}
  ]);
  assert.equal(ranked[0]?.id,'pw');
});

test('observation nodes cannot compile to mutating execution',()=>{
  const node=graph().nodes[0]!;
  assert.throws(()=>compileExecution(node,[
    {id:'bad',modality:'API',capability:'browser.read',expectedSuccess:.9,expectedCost:1,uncertainty:.1,verificationStrength:.9,mutating:true,supportsRollback:true}
  ]),/no execution modality/);
});

test('execution compiler enforces hard node risk limit and unique candidate ids',()=>{
  const node=graph().nodes[1]!;
  assert.throws(()=>compileExecution(node,[
    {id:'pw',modality:'PLAYWRIGHT',capability:'browser.write',expectedSuccess:.9,expectedCost:1,uncertainty:.1,verificationStrength:.9,mutating:true,supportsRollback:true}
  ],{maximumRisk:.2}),/node risk exceeds hard maximumRisk/);

  assert.throws(()=>compileExecution(node,[
    {id:'dup',modality:'GUI',capability:'browser.write',expectedSuccess:.8,expectedCost:1,uncertainty:.2,verificationStrength:.6,mutating:true,supportsRollback:true},
    {id:'dup',modality:'PLAYWRIGHT',capability:'browser.write',expectedSuccess:.9,expectedCost:1,uncertainty:.1,verificationStrength:.9,mutating:true,supportsRollback:true}
  ]),/execution candidate ids must be unique/);
});

test('branch search rejects duplicate candidate identities',()=>{
  const branch={id:'dup',nodeIds:['a'],expectedSuccess:.8,expectedInformationGain:.2,expectedCost:1,risk:.1,uncertainty:.2,verificationStrength:.8,reversibleFraction:1};
  assert.throws(()=>rankPlanBranches([branch,{...branch,nodeIds:['b']}]),/plan branch candidate ids must be unique/);
});
