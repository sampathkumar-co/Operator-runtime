import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPlanFragment, initializeNodeStates, validatePlanGraph } from '../src/index.ts';
import { D, E, goal, graph } from './fixtures.ts';

function eligible(){
  const p=validatePlanGraph(goal(),graph());
  const states=initializeNodeStates(p);
  states.find(s=>s.nodeId==='observe')!.status='SUCCEEDED';
  states.find(s=>s.nodeId==='act')!.status='SUCCEEDED';
  return {p,states};
}

const aliases={
  'state.observed':'SOURCE_STATE',
  'change.applied':'TARGET_MUTATION',
  'change.verified':'TARGET_VERIFIED'
};

test('reusable fragment strips source fact identities into generic slots',()=>{
  const {p,states}=eligible();
  const fragment=extractPlanFragment({
    graph:p,states,nodeIds:['observe','act'],objectiveKind:'apply-change',scopeClass:'web-form',
    factAliases:aliases,sourceRunIds:['run-a','run-b'],verificationDigests:[D,E]
  });
  assert.match(fragment.digest,/^[0-9a-f]{64}$/);
  const encoded=JSON.stringify(fragment);
  assert.equal(encoded.includes('state.observed'),false);
  assert.equal(encoded.includes('change.applied'),false);
  assert.equal(encoded.includes('SOURCE_STATE'),true);
});

test('fragment extraction refuses benchmark contamination',()=>{
  const {p,states}=eligible();
  assert.throws(()=>extractPlanFragment({
    graph:p,states,nodeIds:['observe'],objectiveKind:'x',scopeClass:'x',
    factAliases:aliases,sourceRunIds:['r1','r2'],verificationDigests:[D,E],
    benchmarkIdentifiers:['task-42']
  }),/benchmark identifiers are forbidden/);
});

test('fragment extraction requires multiple source runs and independent verification evidence',()=>{
  const {p,states}=eligible();
  assert.throws(()=>extractPlanFragment({
    graph:p,states,nodeIds:['observe'],objectiveKind:'x',scopeClass:'x',
    factAliases:aliases,sourceRunIds:['r1'],verificationDigests:[D,E]
  }),/at least two independent source runs/);
  assert.throws(()=>extractPlanFragment({
    graph:p,states,nodeIds:['observe'],objectiveKind:'x',scopeClass:'x',
    factAliases:aliases,sourceRunIds:['r1','r2'],verificationDigests:[D]
  }),/independent verification evidence/);
});

test('fragment cannot learn unverified failure or unmapped source facts',()=>{
  const {p,states}=eligible();
  states.find(s=>s.nodeId==='act')!.status='FAILED';
  assert.throws(()=>extractPlanFragment({
    graph:p,states,nodeIds:['act'],objectiveKind:'x',scopeClass:'x',
    factAliases:aliases,sourceRunIds:['r1','r2'],verificationDigests:[D,E]
  }),/only from succeeded/);

  states.find(s=>s.nodeId==='act')!.status='SUCCEEDED';
  assert.throws(()=>extractPlanFragment({
    graph:p,states,nodeIds:['act'],objectiveKind:'x',scopeClass:'x',
    factAliases:{},sourceRunIds:['r1','r2'],verificationDigests:[D,E]
  }),/generalized through a fact alias/);
});

test('fragment preserves caller execution order and rejects dependency inversion',()=>{
  const {p,states}=eligible();
  const fragment=extractPlanFragment({
    graph:p,states,nodeIds:['observe','act'],objectiveKind:'x',scopeClass:'x',
    factAliases:aliases,sourceRunIds:['r1','r2'],verificationDigests:[D,E]
  });
  assert.deepEqual(fragment.steps.map(step=>step.kind),['OBSERVE','ACTION']);
  assert.throws(()=>extractPlanFragment({
    graph:p,states,nodeIds:['act','observe'],objectiveKind:'x',scopeClass:'x',
    factAliases:aliases,sourceRunIds:['r1','r2'],verificationDigests:[D,E]
  }),/preserve dependency execution order/);
  assert.throws(()=>extractPlanFragment({
    graph:p,states,nodeIds:['observe','observe'],objectiveKind:'x',scopeClass:'x',
    factAliases:aliases,sourceRunIds:['r1','r2'],verificationDigests:[D,E]
  }),/must be unique and ordered/);
});
