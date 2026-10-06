import assert from 'node:assert/strict';
import test from 'node:test';
import { createCounterfactualTwinManifest, twinSupportsClaim } from '../src/core/counterfactual-twin.ts';
import { evaluateProofClaim } from '../src/core/proof-kernel.ts';
import { compileDistributedPlacement } from '../src/core/distributed-placement.ts';
import { certifyAutonomousObjective } from '../src/core/autonomous-objective-certification.ts';
import { createDeveloperSession, updateDeveloperSession } from '../src/core/developer-session.ts';
import { createEvidencePack } from '../src/core/evidence-pack.ts';

test('counterfactual twin refuses to claim coverage for partial or absent dimensions',()=>{
 const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64);
 const twin=createCounterfactualTwinManifest({
  workspaceGraphId:a,environmentDigest:b,authorityDigest:c,artifactIds:[a],
  fidelity:[
   {dimension:'repository',state:'MODELED',evidenceArtifactIds:[a]},
   {dimension:'database',state:'ABSENT',evidenceArtifactIds:[],limitation:'Production database is not modeled.'}
  ],
  createdAt:'2026-10-06T00:00:00.000Z'
 });
 const support=twinSupportsClaim(twin,['repository','database']);
 assert.equal(support.supported,false); assert.deepEqual(support.missing,['database']);
});

test('proof kernel does not upgrade model inference to proof',()=>{
 const d=evaluateProofClaim({evidence:[{artifactId:'a'.repeat(64),evidenceClass:'MODEL_INFERENCE',passed:true,independent:false}]});
 assert.equal(d.level,'INFERRED');
});

test('proof kernel recognizes independent deterministic evidence',()=>{
 const d=evaluateProofClaim({evidence:[{artifactId:'a'.repeat(64),evidenceClass:'STATIC_ANALYSIS',passed:true,independent:true}]});
 assert.equal(d.level,'PROVEN');
});

test('distributed placement compiles authority-bound locality and isolation into existing device pool constraints',()=>{
 const p=compileDistributedPlacement({schemaVersion:1,objectiveId:'obj-1',workUnitId:'work-1',authorityDigest:'a'.repeat(64),requiredCapabilities:['git.status'],requiredOs:'windows',securityClass:'sensitive',dataLocalityTags:['repo-alpha']});
 assert.ok(p.devicePoolRequest.requiredTags?.includes('os:windows'));
 assert.ok(p.devicePoolRequest.requiredTags?.includes('security:sensitive'));
 assert.ok(p.devicePoolRequest.requiredTags?.includes('data:repo-alpha'));
 assert.match(p.placementKey,/^[0-9a-f]{64}$/);
});

test('R10 objective certification fails closed on completion without verification',()=>{
 const session=updateDeveloperSession(createDeveloperSession({objective:'Ship',acceptanceCriteria:['Verified'],workspaceRootNodeId:'workspace:root',now:'2026-10-06T00:00:00.000Z'}),{status:'COMPLETED'},'2026-10-06T00:00:02.000Z');
 const source='a'.repeat(64);
 const pack=createEvidencePack({executionContext:{schemaVersion:1,taskId:'task-1'},artifactIds:[source],claims:[{id:'result',statement:'Result verified',level:'EMPIRICALLY_VERIFIED',artifactIds:[source]}],rollbackStatus:'AVAILABLE',now:'2026-10-06T00:00:01.000Z'});
 const cert=certifyAutonomousObjective({session,evidencePack:pack,requiredClaimIds:['result'],traceEvents:[
  {schemaVersion:1,id:'e1',traceId:'t1',executionContextDigest:'b'.repeat(64),stage:'REQUEST',outcome:'OK',at:'2026-10-06T00:00:00.000Z',attributes:{}},
  {schemaVersion:1,id:'e2',traceId:'t1',executionContextDigest:'b'.repeat(64),stage:'COMPLETE',outcome:'OK',at:'2026-10-06T00:00:01.000Z',attributes:{}}
 ]});
 assert.equal(cert.status,'NOT_CERTIFIED'); assert.match(cert.reasons.join(' '),/without independent verification/);
});
