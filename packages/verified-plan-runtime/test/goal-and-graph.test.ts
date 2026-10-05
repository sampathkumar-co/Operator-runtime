import test from 'node:test';
import assert from 'node:assert/strict';
import { compileGoal, validatePlanGraph, initializeNodeStates, readyNodeIds, dependentClosure } from '../src/index.ts';
import { D, goal, graph, belief } from './fixtures.ts';

test('goal compiler preserves hard semantics and rejects required/forbidden overlap',()=>{
  const compiled=compileGoal({
    id:'g',kind:'purchase',objective:'Buy one item',
    successFactKeys:['order.created'],forbiddenFactKeys:['duplicate.order'],
    constraints:[{id:'c1',strength:'MUST',factKey:'price.acceptable',expectedValueDigest:D,description:'Stay under limit'}],
    unresolvedAssumptions:['user is authenticated']
  });
  assert.equal(compiled.constraints[0]?.strength,'MUST');
  assert.throws(()=>compileGoal({id:'g',kind:'x',objective:'x',successFactKeys:['x'],forbiddenFactKeys:['x']}),/both required and forbidden/);
});

test('goal compiler rejects contradictory hard constraints',()=>{
  assert.throws(()=>compileGoal({
    id:'g',kind:'x',objective:'x',successFactKeys:['done'],
    constraints:[
      {id:'a',strength:'MUST',factKey:'f',description:'must'},
      {id:'b',strength:'MUST_NOT',factKey:'f',description:'must not'}
    ]
  }),/contradictory hard constraints/);
});

test('plan graph rejects cycles and unknown dependencies',()=>{
  const g=goal();
  const cyclic=graph();
  cyclic.nodes[0]!.dependsOn=['verify'];
  assert.throws(()=>validatePlanGraph(g,cyclic),/cycle/);
  const unknown=graph();
  unknown.nodes[1]!.dependsOn=['missing'];
  assert.throws(()=>validatePlanGraph(g,unknown),/unknown dependency/);
});

test('ready nodes are dependency and belief gated',()=>{
  const p=validatePlanGraph(goal(),graph());
  const states=initializeNodeStates(p,'2026-10-05T10:00:00.000Z');
  assert.deepEqual(readyNodeIds(p,states,[]),['observe']);
  states[0]!.status='SUCCEEDED';
  assert.deepEqual(readyNodeIds(p,states,[]),[]);
  assert.deepEqual(readyNodeIds(p,states,[belief('state.observed')]),['act']);
});

test('dependent closure invalidates only affected future cone',()=>{
  const p=validatePlanGraph(goal(),graph());
  assert.deepEqual(dependentClosure(p,['act']),['act','verify']);
  assert.deepEqual(dependentClosure(p,['observe']),['act','observe','verify']);
});
