import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeNodeStates, revisePlan, selectChoiceBranch, validatePlanGraph
} from '../src/index.ts';
import { goal, graph } from './fixtures.ts';

function choiceGraph(){
  const g=graph();
  const act=g.nodes.find(n=>n.id==='act')!;
  act.choiceGroup='write-path';
  const alt={
    ...structuredClone(act),id:'act-alt',title:'Alternative write path',choiceGroup:'write-path',
    allowedCapabilities:['browser.alt-write']
  };
  const verifyAlt={
    ...structuredClone(g.nodes.find(n=>n.id==='verify')!),
    id:'verify-alt',title:'Verify alternative',dependsOn:['act-alt']
  };
  g.nodes.push(alt,verifyAlt);
  return g;
}

test('choice selection skips only the non-selected exclusive branch',()=>{
  const p=validatePlanGraph(goal(),choiceGraph());
  const states=initializeNodeStates(p,'2026-10-05T10:00:00.000Z');
  states.find(s=>s.nodeId==='observe')!.status='SUCCEEDED';
  states.find(s=>s.nodeId==='act')!.status='READY';
  states.find(s=>s.nodeId==='act-alt')!.status='READY';
  const out=selectChoiceBranch(p,states,'write-path','act','2026-10-05T10:01:00.000Z');
  assert.deepEqual(out.skippedNodeIds,['act-alt','verify-alt']);
  assert.equal(out.states.find(s=>s.nodeId==='act')?.status,'READY');
  assert.equal(out.states.find(s=>s.nodeId==='act-alt')?.status,'SKIPPED');
});

test('choice cannot switch away from a successful committed alternative',()=>{
  const p=validatePlanGraph(goal(),choiceGraph());
  const states=initializeNodeStates(p);
  states.find(s=>s.nodeId==='act-alt')!.status='SUCCEEDED';
  assert.throws(()=>selectChoiceBranch(p,states,'write-path','act'),/already committed/);
});

test('plan revision preserves unaffected successful work and resets changed dependency cone',()=>{
  const previous=validatePlanGraph(goal(),graph());
  const states=initializeNodeStates(previous,'2026-10-05T10:00:00.000Z');
  states.find(s=>s.nodeId==='observe')!.status='SUCCEEDED';
  states.find(s=>s.nodeId==='act')!.status='SUCCEEDED';
  states.find(s=>s.nodeId==='verify')!.status='PENDING';

  const next=graph();
  next.version=2;
  next.nodes.find(n=>n.id==='act')!.expectedCost=9;
  const revision=revisePlan(goal(),previous,states,next,'2026-10-05T10:02:00.000Z');
  assert.deepEqual(revision.changedNodeIds,['act']);
  assert.deepEqual(revision.resetNodeIds,['act','verify']);
  assert.deepEqual(revision.preservedSucceededNodeIds,['observe']);
  assert.equal(revision.states.find(s=>s.nodeId==='act')?.attempts,0);
});

test('plan revision cannot silently reuse a version or occur while action is running',()=>{
  const previous=validatePlanGraph(goal(),graph());
  const states=initializeNodeStates(previous);
  const same=graph();
  assert.throws(()=>revisePlan(goal(),previous,states,same),/advance exactly by one/);
  const next=graph(); next.version=2;
  states.find(s=>s.nodeId==='observe')!.status='RUNNING';
  assert.throws(()=>revisePlan(goal(),previous,states,next),/while an execution node is running/);
});

test('choice groups require at least two alternatives with one hierarchical parent',()=>{
  const one=graph(); one.nodes.find(n=>n.id==='act')!.choiceGroup='x';
  assert.throws(()=>validatePlanGraph(goal(),one),/at least two alternatives/);

  const bad=choiceGraph();
  bad.nodes.find(n=>n.id==='act-alt')!.parentId=undefined;
  assert.throws(()=>validatePlanGraph(goal(),bad),/same hierarchical parent/);
});
