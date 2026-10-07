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

test('root preconditions start pending until belief binding proves them',()=>{
  const g=graph();
  g.nodes[0]!.preconditions=[{factKey:'session.ready'}];
  const p=validatePlanGraph(goal(),g);
  const states=initializeNodeStates(p);
  assert.equal(states.find(s=>s.nodeId==='observe')?.status,'PENDING');
  assert.deepEqual(readyNodeIds(p,states,[]),[]);
  assert.deepEqual(readyNodeIds(p,states,[belief('session.ready')]),['observe']);
});

test('goal compiler rejects hard constraints that contradict terminal goal facts',()=>{
  assert.throws(()=>compileGoal({
    id:'g',kind:'x',objective:'x',successFactKeys:['done'],
    constraints:[{id:'deny',strength:'MUST_NOT',factKey:'done',description:'never done'}]
  }),/contradicts required success fact/);
  assert.throws(()=>compileGoal({
    id:'g',kind:'x',objective:'x',successFactKeys:['done'],forbiddenFactKeys:['danger'],
    constraints:[{id:'force',strength:'MUST',factKey:'danger',description:'must danger'}]
  }),/contradicts forbidden goal fact/);
});

test('goal compiler rejects conflicting MUST values for the same fact',()=>{
  assert.throws(()=>compileGoal({
    id:'g',kind:'x',objective:'x',successFactKeys:['done'],
    constraints:[
      {id:'a',strength:'MUST',factKey:'target',expectedValueDigest:D,description:'A'},
      {id:'b',strength:'MUST',factKey:'target',expectedValueDigest:'b'.repeat(64),description:'B'}
    ]
  }),/conflicting MUST values/);
});

test('plan graph rejects contradictory preconditions for one fact',()=>{
  const g=graph();
  g.nodes.find(n=>n.id==='act')!.preconditions=[
    {factKey:'state.observed',expectedValueDigest:D},
    {factKey:'state.observed',expectedValueDigest:'b'.repeat(64)}
  ];
  assert.throws(()=>validatePlanGraph(goal(),g),/conflicting preconditions/);
});

test('readyNodeIds rejects duplicate state and belief identities',()=>{
  const p=validatePlanGraph(goal(),graph());
  const states=initializeNodeStates(p);
  assert.throws(()=>readyNodeIds(p,[...states,structuredClone(states[0]!)],[]),/plan node states must be unique/);
  assert.throws(()=>readyNodeIds(p,states,[
    belief('state.observed'),
    belief('state.observed')
  ]),/belief facts must be unique/);
});
