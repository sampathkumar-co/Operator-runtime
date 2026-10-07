import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { reconstructCounterfactualTwin } from '../src/core/counterfactual-twin-runtime.ts';
import { compareCounterfactualPlans, evaluateCounterfactualPlan } from '../src/core/counterfactual-plan-evaluator.ts';
import { evaluateProofClaim } from '../src/core/proof-kernel.ts';
import { createSignedProofBundle, verifySignedProofBundle, type ProofBundleBody } from '../src/core/proof-bundle.ts';
import { evaluateProofCarryingExecution } from '../src/core/proof-carrying-execution.ts';

function sha(bytes:string):string{return crypto.createHash('sha256').update(bytes,'utf8').digest('hex');}

const bytes={
  repo:'repo snapshot',
  lock:'lockfiles',
  env:'environment manifest',
  service:'service images',
  db:'database fixture',
  browser:'browser state',
  policy:'policy envelope',
  world:'world facts',
  authority:'authority receipt',
  precondition:'precondition evidence',
  action:'action journal evidence',
  verification:'independent verifier evidence'
};
const ids=Object.fromEntries(Object.entries(bytes).map(([key,value])=>[key,sha(value)])) as Record<keyof typeof bytes,string>;
const artifactBytes=Object.fromEntries(Object.entries(ids).map(([key,id])=>[id,bytes[key as keyof typeof bytes]])) as Record<string,string>;

function fullTwin(){
  return reconstructCounterfactualTwin({
    workspaceGraphId:'a'.repeat(64),
    authorityDigest:'b'.repeat(64),
    repository:{artifactIds:[ids.repo]},
    dependencies:{artifactIds:[ids.lock]},
    environment:{artifactIds:[ids.env]},
    services:{artifactIds:[ids.service]},
    database:{artifactIds:[ids.db]},
    browser:{artifactIds:[ids.browser]},
    policy:{artifactIds:[ids.policy]},
    worldState:{artifactIds:[ids.world]},
    virtualResources:{
      'repo:src/app.ts':sha('before app'),
      'repo:src/lib.ts':sha('before lib')
    },
    createdAt:'2026-10-07T12:00:00.000Z'
  });
}

test('R8 reconstructs a content-addressed twin with explicit full fidelity',()=>{
  const twin=fullTwin();
  assert.match(twin.id,/^[0-9a-f]{64}$/);
  assert.match(twin.stateDigest,/^[0-9a-f]{64}$/);
  assert.equal(twin.manifest.fidelity.length,8);
  assert.equal(twin.manifest.fidelity.every((row)=>row.state==='MODELED'),true);
});

test('R8 twin requires explicit limitations for absent reconstruction dimensions',()=>{
  assert.throws(()=>reconstructCounterfactualTwin({
    workspaceGraphId:'a'.repeat(64),authorityDigest:'b'.repeat(64),
    repository:{artifactIds:[ids.repo]},dependencies:{artifactIds:[ids.lock]},environment:{artifactIds:[ids.env]},
    services:{artifactIds:[ids.service]},database:{artifactIds:[]},browser:{artifactIds:[ids.browser]},
    policy:{artifactIds:[ids.policy]},worldState:{artifactIds:[ids.world]},createdAt:'2026-10-07T12:00:00.000Z'
  } as any),/explicit limitation/);
});

test('R8 evaluates alternative plans against twin preconditions, blast radius, tests and reversibility',()=>{
  const twin=fullTwin();
  const beforeApp=twin.virtualResources['repo:src/app.ts']!;
  const beforeLib=twin.virtualResources['repo:src/lib.ts']!;
  const safe={
    id:'safe',requiredDimensions:['repository','dependencies','environment'] as const,
    steps:[{id:'s1',resourceKey:'repo:src/app.ts',beforeDigest:beforeApp,afterDigest:sha('after app'),effect:'update' as const,reversible:true,testIds:['unit:app']}]
  };
  const wide={
    id:'wide',requiredDimensions:['repository','dependencies','environment'] as const,
    steps:[
      {id:'w1',resourceKey:'repo:src/app.ts',beforeDigest:beforeApp,afterDigest:sha('after app'),effect:'update' as const,reversible:false,testIds:['unit:app']},
      {id:'w2',resourceKey:'repo:src/lib.ts',beforeDigest:beforeLib,afterDigest:sha('after lib'),effect:'update' as const,reversible:false,testIds:['unit:lib']}
    ]
  };
  const ranked=compareCounterfactualPlans(twin,[wide,safe] as any);
  assert.equal(ranked[0]?.planId,'safe');
  assert.equal(ranked[0]?.eligible,true);
  assert.equal(ranked[0]?.blastRadius,1);
  assert.equal(ranked[1]?.irreversibleEffects,2);

  const bad=evaluateCounterfactualPlan(twin,{
    id:'bad',requiredDimensions:['repository'],
    steps:[{id:'b1',resourceKey:'repo:src/app.ts',beforeDigest:'f'.repeat(64),afterDigest:sha('bad'),effect:'update',reversible:true}]
  });
  assert.equal(bad.eligible,false);
  assert.match(bad.conflicts.join(' '),/precondition/);
});

test('R8 proof kernel never upgrades inference and recognizes invariant/dependency evidence',()=>{
  const inference=evaluateProofClaim({evidence:[{artifactId:ids.precondition,evidenceClass:'MODEL_INFERENCE',passed:true,independent:false}]});
  assert.equal(inference.level,'INFERRED');
  const proven=evaluateProofClaim({evidence:[
    {artifactId:ids.precondition,evidenceClass:'DEPENDENCY_GRAPH',passed:true,independent:true},
    {artifactId:ids.policy,evidenceClass:'INVARIANT_CHECK',passed:true,independent:true}
  ]});
  assert.equal(proven.level,'PROVEN');
});

function body(overrides:Partial<ProofBundleBody>={}):ProofBundleBody{
  return{
    objective:{id:'objective-1',statement:'Release the verified build'},
    constraints:['no authority expansion','rollback available'],
    authority:{
      leaseId:'lease-1',principalId:'agent:deploy',purpose:'release verified build',
      authorityDigest:'b'.repeat(64),expiresAt:'2026-10-07T14:00:00.000Z',artifactIds:[ids.authority]
    },
    planLineage:{planId:'safe',decisionDigest:sha('plan decision')},
    preconditions:[{id:'source-clean',level:'PROVEN',artifactIds:[ids.precondition]}],
    actionJournal:[{
      actionId:'action-1',effect:'update',resourceKey:'repo:src/app.ts',
      beforeDigest:sha('before app'),afterDigest:sha('after app'),artifactIds:[ids.action]
    }],
    verification:[{claimId:'release-ok',level:'EMPIRICALLY_VERIFIED',artifactIds:[ids.verification],verifier:'verifier:independent',independent:true}],
    residualUncertainty:[],
    rollbackStatus:'AVAILABLE',
    createdAt:'2026-10-07T12:05:00.000Z',
    ...overrides
  };
}

test('R8 proof bundles are externally machine-verifiable and reject tampering or missing artifacts',()=>{
  const keys=crypto.generateKeyPairSync('ed25519');
  const privateKeyPem=keys.privateKey.export({format:'pem',type:'pkcs8'}).toString();
  const publicKeyPem=keys.publicKey.export({format:'pem',type:'spki'}).toString();
  const bundle=createSignedProofBundle(body(),{keyId:'proof-key-1',privateKeyPem});
  const verified=verifySignedProofBundle(bundle,{publicKeyPem,artifactBytes});
  assert.equal(verified.valid,true);
  assert.equal(verified.digest,bundle.digest);

  const tampered=structuredClone(bundle);
  tampered.body.objective.statement='tampered';
  const bad=verifySignedProofBundle(tampered,{publicKeyPem,artifactBytes});
  assert.equal(bad.valid,false);
  assert.match(bad.reasons.join(' '),/digest|signature/);

  const missing=verifySignedProofBundle(bundle,{publicKeyPem,artifactBytes:{...artifactBytes,[ids.verification]:undefined as any}});
  assert.equal(missing.valid,false);
  assert.match(missing.reasons.join(' '),/missing/);
});

test('R8 proof-carrying execution allows strong verified proof and fails closed on inference or fidelity gaps',()=>{
  const keys=crypto.generateKeyPairSync('ed25519');
  const privateKeyPem=keys.privateKey.export({format:'pem',type:'pkcs8'}).toString();
  const publicKeyPem=keys.publicKey.export({format:'pem',type:'spki'}).toString();
  const twin=fullTwin();
  const bundle=createSignedProofBundle(body(),{keyId:'proof-key-1',privateKeyPem});
  const allowed=evaluateProofCarryingExecution({
    twin,bundle,publicKeyPem,artifactBytes,
    requiredTwinDimensions:['repository','dependencies','environment','services','database','browser','policy','world-state'],
    irreversible:true,now:'2026-10-07T12:10:00.000Z'
  });
  assert.equal(allowed.allowed,true);

  const inferenceBundle=createSignedProofBundle(body({
    preconditions:[{id:'source-clean',level:'INFERRED',artifactIds:[ids.precondition]}]
  }),{keyId:'proof-key-1',privateKeyPem});
  const denied=evaluateProofCarryingExecution({
    twin,bundle:inferenceBundle,publicKeyPem,artifactBytes,requiredTwinDimensions:['repository'],irreversible:true,now:'2026-10-07T12:10:00.000Z'
  });
  assert.equal(denied.allowed,false);
  assert.match(denied.reasons.join(' '),/INFERRED/);

  const limited=reconstructCounterfactualTwin({
    workspaceGraphId:'a'.repeat(64),authorityDigest:'b'.repeat(64),
    repository:{artifactIds:[ids.repo]},dependencies:{artifactIds:[ids.lock]},environment:{artifactIds:[ids.env]},
    services:{artifactIds:[ids.service]},database:{artifactIds:[],limitation:'Production database intentionally excluded.'},
    browser:{artifactIds:[ids.browser]},policy:{artifactIds:[ids.policy]},worldState:{artifactIds:[ids.world]},
    virtualResources:{'repo:src/app.ts':sha('before app')},createdAt:'2026-10-07T12:00:00.000Z'
  });
  const noDb=evaluateProofCarryingExecution({
    twin:limited,bundle,publicKeyPem,artifactBytes,requiredTwinDimensions:['database'],irreversible:false,now:'2026-10-07T12:10:00.000Z'
  });
  assert.equal(noDb.allowed,false);
  assert.match(noDb.reasons.join(' '),/database.*absent/i);
});
