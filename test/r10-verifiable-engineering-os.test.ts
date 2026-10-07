import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EmbeddedControlPlaneStore } from '../src/core/control-plane-store.ts';
import { createSignedProofBundle, type ProofBundleBody } from '../src/core/proof-bundle.ts';
import { EngineeringObjectiveLifecycle, type EngineeringObjectiveRecord } from '../src/core/engineering-objective-lifecycle.ts';
import { EngineeringCausalMemoryStore, causalMemoryDigest } from '../src/core/engineering-causal-memory.ts';
import {
  ReceiptGatedLearningStore,
  evaluateProofAwarePlans,
  normalizeAgentTrustEnvelope
} from '../src/core/proof-aware-autonomy.ts';
import {
  AutonomousIncidentCommand,
  certifyVerifiableEngineeringOS,
  compileEngineeringOperatingLoop
} from '../src/core/autonomous-incident-certification.ts';

const sha=(value:string)=>crypto.createHash('sha256').update(value,'utf8').digest('hex');
const start='2026-10-07T16:00:00.000Z';
const authority=sha('authority');
const workspace=sha('workspace');

function goodMetrics(){
  return {
    verifiedTaskSuccessRate:0.84,
    falseCompletionRate:0.04,
    humanInterventionRate:0.28,
    interruptionRecoveryRate:0.995,
    authorityViolations:0,
    portableProofRate:0.998,
    uncertaintyCalibrationError:0.04,
    rollbackSuccessRate:0.997,
    learningPolicyViolations:0
  };
}
function baselineMetrics(){
  return {
    verifiedTaskSuccessRate:0.70,
    falseCompletionRate:0.10,
    humanInterventionRate:0.50,
    interruptionRecoveryRate:0.80,
    authorityViolations:0,
    portableProofRate:0.70,
    uncertaintyCalibrationError:0.20,
    rollbackSuccessRate:0.85,
    learningPolicyViolations:0
  };
}

const evidenceBytes={
  authority:'authority evidence',
  precondition:'precondition evidence',
  action:'action evidence',
  verification:'verification evidence'
};
const evidenceIds=Object.fromEntries(Object.entries(evidenceBytes).map(([key,value])=>[key,sha(value)])) as Record<keyof typeof evidenceBytes,string>;
const artifactBytes=Object.fromEntries(Object.entries(evidenceIds).map(([key,id])=>[id,evidenceBytes[key as keyof typeof evidenceBytes]])) as Record<string,string>;

function proofBody():ProofBundleBody{
  return {
    objective:{id:'objective-10',statement:'Ship a verified distributed change'},
    constraints:['no authority expansion'],
    authority:{
      leaseId:'lease-10',principalId:'agent:engineering',purpose:'verified engineering',
      authorityDigest:authority,expiresAt:'2026-10-07T18:00:00.000Z',artifactIds:[evidenceIds.authority]
    },
    planLineage:{planId:'plan-10',decisionDigest:sha('decision')},
    preconditions:[{id:'source-clean',level:'PROVEN',artifactIds:[evidenceIds.precondition]}],
    actionJournal:[{
      actionId:'action-10',effect:'update',resourceKey:'repo:src/app.ts',
      beforeDigest:sha('before'),afterDigest:sha('after'),artifactIds:[evidenceIds.action]
    }],
    verification:[{
      claimId:'verified-output',level:'EMPIRICALLY_VERIFIED',artifactIds:[evidenceIds.verification],
      verifier:'verifier:independent',independent:true
    }],
    residualUncertainty:[],
    rollbackStatus:'AVAILABLE',
    createdAt:'2026-10-07T16:05:00.000Z'
  };
}

async function advanceToCertified(
  lifecycle:EngineeringObjectiveLifecycle,
  bundleDigest:string,
  certificationDigest:string
):Promise<EngineeringObjectiveRecord>{
  await lifecycle.create({id:'objective-10',statement:'Ship a verified distributed change',constraints:['no authority expansion'],authorityDigest:authority,workspaceGraphId:workspace});
  await lifecycle.transition('objective-10','PLANNED',{planDigest:sha('plan')});
  await lifecycle.transition('objective-10','AUTHORIZED',{authorityLeaseId:'lease-10'});
  await lifecycle.transition('objective-10','TWIN_READY',{twinId:sha('twin'),twinStateDigest:sha('twin-state')});
  await lifecycle.transition('objective-10','PROOF_GATED',{proofBundleDigest:bundleDigest});
  await lifecycle.transition('objective-10','EXECUTING',{fabricPlanDigest:sha('fabric-plan')});
  await lifecycle.transition('objective-10','VERIFYING',{distributedLineageDigests:[sha('lineage')]});
  return await lifecycle.transition('objective-10','CERTIFIED',{
    evidencePackId:'evidence-pack-10',
    certificationDigest,
    residualUncertainty:[]
  });
}

test('R10 objective lifecycle is proof-gated and interruption/recovery is durable',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'r10-life-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let clock=new Date(start);
  const lifecycle=new EngineeringObjectiveLifecycle(new EmbeddedControlPlaneStore(root),{clock:()=>clock});
  await lifecycle.create({id:'obj',statement:'Do verified work',constraints:['bounded'],authorityDigest:authority,workspaceGraphId:workspace});
  await assert.rejects(()=>lifecycle.transition('obj','PLANNED'),(error:any)=>error?.code==='ENGINEERING_OBJECTIVE_PROOF_REQUIRED');
  await lifecycle.transition('obj','PLANNED',{planDigest:sha('plan')});
  await lifecycle.transition('obj','AUTHORIZED',{authorityLeaseId:'lease'});
  await lifecycle.transition('obj','TWIN_READY',{twinId:sha('twin'),twinStateDigest:sha('state')});
  await lifecycle.transition('obj','PROOF_GATED',{proofBundleDigest:sha('proof')});
  await lifecycle.transition('obj','EXECUTING',{fabricPlanDigest:sha('fabric')});
  clock=new Date(Date.parse(start)+1000);
  const interrupted=await lifecycle.interrupt('obj','worker disconnected before final receipt');
  assert.equal(interrupted.state,'RECOVERY_REQUIRED');
  assert.equal(interrupted.interruptionCount,1);
  const resumed=await lifecycle.resume('obj',{recoveryReceiptDigest:sha('recovery'),residualUncertainty:[]});
  assert.equal(resumed.state,'EXECUTING');
  assert.equal(resumed.recoveryCount,1);
  assert.equal(resumed.residualUncertainty.length,0);
});

test('R10 causal memory invalidation cascades through dependent engineering history',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'r10-memory-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new EmbeddedControlPlaneStore(root);
  const lifecycle=new EngineeringObjectiveLifecycle(store,{clock:()=>new Date(start)});
  const memory=new EngineeringCausalMemoryStore(store,{clock:()=>new Date(start)});
  await lifecycle.create({id:'obj',statement:'Remember verified lineage',constraints:['bounded'],authorityDigest:authority,workspaceGraphId:workspace});
  const rootMemory=await memory.append({id:'m1',objectiveId:'obj',kind:'observation',payloadDigest:sha('observation'),evidenceIds:[sha('e1')],provenance:{actorId:'agent:a',system:'runtime',sourceDigest:sha('source')}});
  const child=await memory.append({id:'m2',objectiveId:'obj',kind:'action',payloadDigest:sha('action'),parentIds:['m1'],evidenceIds:[sha('e2')],provenance:{actorId:'agent:b',system:'runtime',sourceDigest:sha('source2')}});
  await memory.append({id:'m3',objectiveId:'obj',kind:'verification',payloadDigest:sha('verification'),parentIds:['m2'],evidenceIds:[sha('e3')],provenance:{actorId:'verifier',system:'runtime',sourceDigest:sha('source3')}});
  const before=await memory.listObjective('obj');
  assert.match(causalMemoryDigest(before),/^[0-9a-f]{64}$/);
  const invalidated=await memory.invalidate(rootMemory.id,'source observation was superseded');
  assert.deepEqual(invalidated.map((item)=>item.id).sort(),['m1','m2','m3']);
  assert.equal((await memory.get(child.id))?.valid,false);
  await assert.rejects(()=>memory.assertUsable(['m3']),(error:any)=>error?.code==='ENGINEERING_CAUSAL_MEMORY_INVALIDATED');
});

test('R10 proof-aware planner rejects inference and unsafe irreversible candidates',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'r10-plan-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const lifecycle=new EngineeringObjectiveLifecycle(new EmbeddedControlPlaneStore(root),{clock:()=>new Date(start)});
  const objective=await lifecycle.create({id:'obj',statement:'Choose verified plan',constraints:['bounded'],authorityDigest:authority,workspaceGraphId:workspace});
  const decision=evaluateProofAwarePlans(objective,[
    {id:'inference',planDigest:sha('p1'),authorityDigest:authority,proofLevel:'INFERRED',uncertaintyScore:0.01,reversible:true,mutating:false,verificationObligations:['postcondition'],estimatedBlastRadius:0,predictedSuccess:1},
    {id:'unsafe-irreversible',planDigest:sha('p2'),authorityDigest:authority,proofLevel:'CORROBORATED',uncertaintyScore:0.01,reversible:false,mutating:true,verificationObligations:['postcondition'],estimatedBlastRadius:1,predictedSuccess:0.99},
    {id:'strong',planDigest:sha('p3'),authorityDigest:authority,proofLevel:'PROVEN',uncertaintyScore:0.02,reversible:false,mutating:true,verificationObligations:['postcondition','independent-verifier','recovery-plan'],estimatedBlastRadius:1,predictedSuccess:0.90}
  ]);
  assert.equal(decision.selectedPlanId,'strong');
  assert.equal(decision.evaluations.find((item)=>item.id==='inference')?.eligible,false);
  assert.equal(decision.evaluations.find((item)=>item.id==='unsafe-irreversible')?.eligible,false);
});

test('R10 cross-agent interoperability preserves identical trust semantics across vendors',()=>{
  const common={
    principalId:'principal:1',objectiveId:'objective-10',authorityDigest:authority,
    planDigest:sha('plan'),proofBundleDigest:sha('proof'),lineageDigests:[sha('lineage')],
    evidenceDigests:[sha('evidence')],outcome:'VERIFIED' as const
  };
  const a=normalizeAgentTrustEnvelope({vendor:'vendor-a',agentStack:'stack-a',...common});
  const b=normalizeAgentTrustEnvelope({vendor:'vendor-b',agentStack:'stack-b',...common});
  assert.equal(a.authorityDigest,b.authorityDigest);
  assert.equal(a.proofBundleDigest,b.proofBundleDigest);
  assert.deepEqual(a.lineageDigests,b.lineageDigests);
  assert.notEqual(a.envelopeDigest,b.envelopeDigest);
});

test('R10 receipt-gated learning accepts only externally verified certified outcomes',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'r10-learning-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new EmbeddedControlPlaneStore(root);
  const lifecycle=new EngineeringObjectiveLifecycle(store,{clock:()=>new Date(start)});
  const keys=crypto.generateKeyPairSync('ed25519');
  const privateKeyPem=keys.privateKey.export({format:'pem',type:'pkcs8'}).toString();
  const publicKeyPem=keys.publicKey.export({format:'pem',type:'spki'}).toString();
  const bundle=createSignedProofBundle(proofBody(),{keyId:'proof-key-10',privateKeyPem});
  const certification=certifyVerifiableEngineeringOS({baseline:baselineMetrics(),current:goodMetrics()});
  assert.equal(certification.status,'CERTIFIED');
  await advanceToCertified(lifecycle,bundle.digest,certification.certificationDigest);
  const learning=new ReceiptGatedLearningStore(store,{clock:()=>new Date(start)});
  const learned=await learning.learn({
    objectiveId:'objective-10',strategyKey:'verified-build',contentDigest:sha('strategy-content'),
    proofBundle:bundle,publicKeyPem,artifactBytes,
    certification
  });
  assert.equal(learned.verificationCount,1);
  assert.deepEqual(learned.sourceObjectiveIds,['objective-10']);

  await assert.rejects(()=>learning.learn({
    objectiveId:'objective-10',strategyKey:'tampered',contentDigest:sha('other'),
    proofBundle:bundle,publicKeyPem,artifactBytes:{...artifactBytes,[evidenceIds.verification]:'tampered'},
    certification
  }),(error:any)=>error?.code==='RECEIPT_GATED_LEARNING_DENIED');
});

test('R10 autonomous incident command enforces blast radius and independent validation',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'r10-incident-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new EmbeddedControlPlaneStore(root);
  const lifecycle=new EngineeringObjectiveLifecycle(store,{clock:()=>new Date(start)});
  await lifecycle.create({id:'obj',statement:'Recover incident safely',constraints:['blast radius 2'],authorityDigest:authority,workspaceGraphId:workspace});
  const command=new AutonomousIncidentCommand(store,{clock:()=>new Date(start)});
  await command.detect({id:'inc',objectiveId:'obj',authorityDigest:authority,severity:'HIGH',maxBlastRadius:2,affectedResourceDigests:[sha('r1')],detectionDigest:sha('detect'),evidenceDigests:[sha('ev0')]});
  await assert.rejects(()=>command.advance('inc',{phase:'CONTAINED',affectedResourceDigests:[sha('r1'),sha('r2'),sha('r3')],evidenceDigests:[sha('ev1')],phaseDigest:sha('contain')}),(error:any)=>error?.code==='INCIDENT_BLAST_RADIUS_EXCEEDED');
  await command.advance('inc',{phase:'CONTAINED',affectedResourceDigests:[sha('r1'),sha('r2')],evidenceDigests:[sha('ev1')],phaseDigest:sha('contain')});
  await command.advance('inc',{phase:'DIAGNOSED',evidenceDigests:[sha('ev2')],phaseDigest:sha('diagnose')});
  await command.advance('inc',{phase:'REPAIRED',evidenceDigests:[sha('ev3')],phaseDigest:sha('repair'),rollbackOrRecoveryDigest:sha('rollback')});
  await command.advance('inc',{phase:'VALIDATED',evidenceDigests:[sha('ev4')],phaseDigest:sha('validate'),independentVerifierDigest:sha('independent')});
  const recovered=await command.advance('inc',{phase:'RECOVERED',evidenceDigests:[sha('ev5')],phaseDigest:sha('recover')});
  assert.equal(recovered.phase,'RECOVERED');
  assert.equal(recovered.independentVerifierDigest,sha('independent'));
});

test('R10 portable certification measures improvement, proof, authority and recovery',()=>{
  const certified=certifyVerifiableEngineeringOS({baseline:baselineMetrics(),current:goodMetrics()});
  assert.equal(certified.status,'CERTIFIED');
  assert.equal(certified.authorityViolations,0);
  assert.equal(certified.portableProof,true);
  const bad=certifyVerifiableEngineeringOS({
    baseline:baselineMetrics(),
    current:{...goodMetrics(),verifiedTaskSuccessRate:0.71,falseCompletionRate:0.11,authorityViolations:1}
  });
  assert.equal(bad.status,'NOT_CERTIFIED');
  assert.match(bad.reasons.join(' '),/success|false completion|authority/i);
});

test('R10 integrated operating loop closes only when every prior-release proof binding exists',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'r10-loop-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new EmbeddedControlPlaneStore(root);
  const lifecycle=new EngineeringObjectiveLifecycle(store,{clock:()=>new Date(start)});
  const keys=crypto.generateKeyPairSync('ed25519');
  const bundle=createSignedProofBundle(proofBody(),{keyId:'proof-key-10',privateKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString()});
  const certification=certifyVerifiableEngineeringOS({baseline:baselineMetrics(),current:goodMetrics()});
  const objective=await advanceToCertified(lifecycle,bundle.digest,certification.certificationDigest);
  const loop=compileEngineeringOperatingLoop({
    objective,
    causalMemoryDigest:sha('memory'),
    distributedResultDigests:[sha('result')],
    learnedStrategyDigests:[sha('skill')],
    incidentDigests:[sha('incident')]
  });
  assert.equal(loop.complete,true);
  assert.deepEqual(loop.missing,[]);
  assert.match(loop.loopDigest,/^[0-9a-f]{64}$/);
});
