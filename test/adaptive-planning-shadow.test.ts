import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  adaptiveRecoveryToAdvisory,
  coreActionToAdaptiveDescriptor,
  coreEvidenceToAdaptiveRefs,
  coreResultToAdaptiveOutcome,
  verifiedObservationFromAuthoritativeOutcome
} from '../src/core/intelligence-adapters.ts';
import { ShadowDecisionStore } from '../src/core/shadow-decision-store.ts';
import { adaptiveResultToShadowAdvisory, VerifiedPlanShadow } from '../src/core/adaptive-planning-shadow.ts';
import { compileGoal } from '../packages/verified-plan-runtime/src/goal-compiler.ts';

test('core evidence crosses the shadow boundary only as digests and classifications',()=>{
 const refs=coreEvidenceToAdaptiveRefs([{kind:'file.stat',status:'pass',message:'secret-ish message is hashed, not copied',data:{path:'private'},timestamp:'2026-10-06T00:00:00.000Z'}]);
 assert.equal(refs.length,1);
 assert.match(refs[0]!.digest,/^[0-9a-f]{64}$/);
 assert.equal('message' in refs[0]!,false);
 assert.equal('data' in refs[0]!,false);
});

test('core action/result adapters preserve lineage-relevant classification without raw output',()=>{
 const action={id:'action-1',capability:'file.write',risk:'write' as const,input:{content:'secret'},provenance:{kind:'chatgpt' as const},target:'C:/secret.txt'};
 const result={ok:true,capability:'file.write',provider:'filesystem',output:{raw:'not copied'},evidence:[],durationMs:5};
 const a=coreActionToAdaptiveDescriptor(action,{expectedEffects:['file.changed']});
 const o=coreResultToAdaptiveOutcome(action,result);
 assert.equal(a.semanticTarget?.length,64);
 assert.equal(o.sideEffectState,'known');
 assert.equal('output' in o,false);
});

test('recovery vocabulary is closed and advisory-only',()=>{
 assert.equal(adaptiveRecoveryToAdvisory('REOBSERVE'),'OBSERVE');
 assert.equal(adaptiveRecoveryToAdvisory('FAIL_SAFE'),'FAIL_SAFE');
});

test('authoritative result becomes verified-plan observation only from explicit fact deltas',()=>{
 const observation=verifiedObservationFromAuthoritativeOutcome({
  result:{ok:true,capability:'file.write',provider:'fs',evidence:[],durationMs:2},
  changedFactKeys:['file:changed'],
  supportedFactKeys:['test:pass'],
  evidenceDigests:['a'.repeat(64)]
 });
 assert.deepEqual(observation.changedFactKeys,['file:changed']);
 assert.deepEqual(observation.supportedFactKeys,['test:pass']);
});

test('shadow store persists only bounded decision metadata',async(t)=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-shadow-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=new ShadowDecisionStore(dir);
 await store.append({
  source:'ADAPTIVE_INTELLIGENCE',executionContextDigest:'a'.repeat(64),stateDigest:'b'.repeat(64),
  recommendation:'RECONCILE',reasonCode:'SIDE_EFFECT_UNCERTAIN',cohortId:'cohort-1',at:'2026-10-06T00:00:00.000Z'
 });
 const rows=await store.list({cohortId:'cohort-1'});
 assert.equal(rows.length,1); assert.equal(rows[0]?.recommendation,'RECONCILE');
 assert.deepEqual(Object.keys(rows[0]!).sort(),['at','cohortId','executionContextDigest','id','reasonCode','recommendation','schemaVersion','source','stateDigest'].sort());
});

test('VerifiedPlanShadow consumes authoritative observations but has no dispatch path',()=>{
 const goal=compileGoal({id:'goal-1',kind:'test',objective:'Verify fact',successFactKeys:['fact:done']});
 const shadow=new VerifiedPlanShadow(goal,{
  planId:'plan-1',goalId:'goal-1',version:1,rootNodeIds:['node-1'],
  nodes:[{id:'node-1',kind:'ACTION',title:'Observe outcome',dependsOn:[],preconditions:[],expectedEffects:['fact:done'],verificationFactKeys:[],allowedCapabilities:['file.read'],expectedCost:1,risk:0.1,reversible:true,maxAttempts:1}]
 });
 assert.equal(shadow.readyNodes()[0]?.nodeId,'node-1');
 const recorded=shadow.recordAuthoritativeOutcome('node-1',{changedFactKeys:['fact:done'],supportedFactKeys:['fact:done'],contradictedFactKeys:[],executionOk:true,sideEffectState:'none'},'2026-10-06T00:00:00.000Z');
 assert.equal(recorded.state.status,'SUCCEEDED');
 assert.match(shadow.stateDigest(),/^[0-9a-f]{64}$/);
});

test('adaptive result maps progress requiring verification to VERIFY advisory',()=>{
 const advisory=adaptiveResultToShadowAdvisory({
  transition:{} as never,beliefs:[] as never,
  progress:{level:'STATE_CHANGED',confidence:0.8,creditedSignals:[],rejectedSignals:[],goalFactsSatisfied:[],goalFactsMissing:['x'],forbiddenFactsObserved:[],verificationRequired:true}
 });
 assert.equal(advisory?.command,'VERIFY');
});
