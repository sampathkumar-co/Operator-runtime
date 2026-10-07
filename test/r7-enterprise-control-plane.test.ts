import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validatePrincipalDelegationGraph } from '../src/core/principal-delegation.ts';
import { EnterpriseAuthorityLeaseStore } from '../src/core/enterprise-authority-lease.ts';
import { EnterpriseIdentityStore } from '../src/core/enterprise-identity.ts';
import { evaluateEnterprisePolicyLanguage, explainEnterpriseMutation, type EnterprisePolicyRule } from '../src/core/enterprise-policy-language.ts';
import { simulatePolicyAgainstHistory } from '../src/core/enterprise-policy-history.ts';
import { EnterpriseAdminControlPlane } from '../src/core/enterprise-admin.ts';

async function temp(t:test.TestContext):Promise<string>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-r7-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  return dir;
}

test('R7 principal graph spans organization, project and environment scopes without authority widening',()=>{
  const graph=validatePrincipalDelegationGraph({
    schemaVersion:1,
    principals:[
      {id:'org:acme',kind:'organization',enabled:true},
      {id:'project:payments',kind:'project',enabled:true},
      {id:'env:prod',kind:'environment',enabled:true},
      {id:'human:alice',kind:'human',enabled:true},
      {id:'agent:deploy',kind:'agent',enabled:true}
    ],
    delegations:[
      {id:'d-org-project',parentPrincipalId:'org:acme',childPrincipalId:'project:payments',purpose:'own payments',grant:{capabilities:['file.*','deploy.release'],resourcePrefixes:['project:payments'],maxRisk:'system'},createdAt:'2026-10-07T00:00:00.000Z'},
      {id:'d-project-env',parentPrincipalId:'project:payments',childPrincipalId:'env:prod',purpose:'prod boundary',grant:{capabilities:['deploy.release'],resourcePrefixes:['project:payments/prod'],maxRisk:'system'},createdAt:'2026-10-07T00:00:01.000Z'},
      {id:'d-env-human',parentPrincipalId:'env:prod',childPrincipalId:'human:alice',purpose:'release duty',grant:{capabilities:['deploy.release'],resourcePrefixes:['project:payments/prod'],maxRisk:'system'},createdAt:'2026-10-07T00:00:02.000Z'},
      {id:'d-human-agent',parentPrincipalId:'human:alice',childPrincipalId:'agent:deploy',purpose:'deploy one release',grant:{capabilities:['deploy.release'],resourcePrefixes:['project:payments/prod'],maxRisk:'write'},createdAt:'2026-10-07T00:00:03.000Z'}
    ]
  },{'org:acme':{capabilities:['file.*','deploy.*'],resourcePrefixes:['project:payments'],maxRisk:'destructive'}});
  assert.equal(graph.principals.length,5);
});

test('R7 purpose-bound authority leases attenuate, expire, revoke and emergency-halt',async(t)=>{
  const now={value:new Date('2026-10-07T10:00:00.000Z')};
  const store=new EnterpriseAuthorityLeaseStore(await temp(t),{clock:()=>new Date(now.value)});
  const parent=await store.issue({
    principalId:'human:alice',purpose:'release payments',authorityRevision:7,ttlMs:60_000,
    grant:{capabilities:['file.*','deploy.release'],resourcePrefixes:['project:payments'],maxRisk:'system'}
  });
  const child=await store.issue({
    principalId:'agent:deploy',purpose:'release payments',authorityRevision:7,parentLeaseId:parent.id,ttlMs:30_000,
    grant:{capabilities:['deploy.release'],resourcePrefixes:['project:payments/prod'],maxRisk:'write'}
  });
  assert.equal((await store.assertActive(child.id,{principalId:'agent:deploy',purpose:'release payments',authorityRevision:7})).state,'ACTIVE');
  await assert.rejects(()=>store.issue({
    principalId:'agent:bad',purpose:'escape',authorityRevision:7,parentLeaseId:parent.id,ttlMs:30_000,
    grant:{capabilities:['terminal.execute'],resourcePrefixes:['project:payments'],maxRisk:'write'}
  }),/expands capability/);
  assert.equal((await store.revoke(child.id,'release finished')).state,'REVOKED');
  await store.emergencyHalt('incident');
  await assert.rejects(()=>store.assertActive(parent.id), (error:any)=>error?.code==='ENTERPRISE_EMERGENCY_HALTED');
  await store.clearEmergencyHalt();
  await assert.rejects(()=>store.assertActive(parent.id), (error:any)=>error?.code==='ENTERPRISE_AUTHORITY_LEASE_INACTIVE');
});

test('R7 enterprise identity provisions SCIM users and resolves only verified SSO claims',async(t)=>{
  const store=new EnterpriseIdentityStore(await temp(t));
  await store.configureProviders([{id:'corp',issuer:'https://id.example.com',audiences:['mecord'],enabled:true}]);
  await store.upsertScimUser({providerId:'corp',subject:'00u-alice',principalId:'human:alice',email:'alice@example.com',roleIds:['release-manager'],groups:['payments'],externalId:'scim-1'});
  const resolved=await store.resolveSso({providerId:'corp',issuer:'https://id.example.com',audience:'mecord',subject:'00u-alice',verified:true});
  assert.equal(resolved.principalId,'human:alice');
  assert.deepEqual(resolved.roleIds,['release-manager']);
  await assert.rejects(()=>store.resolveSso({providerId:'corp',issuer:'https://id.example.com',audience:'mecord',subject:'00u-alice',verified:false}),(error:any)=>error?.code==='ENTERPRISE_SSO_UNVERIFIED');
  await store.deactivateScimUser('corp','00u-alice');
  await assert.rejects(()=>store.resolveSso({providerId:'corp',issuer:'https://id.example.com',audience:'mecord',subject:'00u-alice',verified:true}),(error:any)=>error?.code==='ENTERPRISE_SSO_SUBJECT_DENIED');
});

const rules:EnterprisePolicyRule[]=[{
  id:'prod-release',
  principalPrefixes:['human:','agent:'],
  capabilityPatterns:['deploy.*'],
  maxRisk:'system',
  resourcePrefixes:['project:payments/prod'],
  environments:['prod'],
  requiredDevicePosture:['managed','encrypted'],
  allowedLocations:['IN'],
  sessionPrefixes:['release:'],
  notBefore:'2026-10-07T00:00:00.000Z',
  notAfter:'2026-10-08T00:00:00.000Z',
  minApprovalQuorum:2,
  requireSeparationOfDuties:true,
  requiredEvidenceClasses:['STATIC_ANALYSIS','INDEPENDENT_TEST'],
  requireIndependentVerifier:true,
  maxActionCost:5,
  maxSessionCost:50,
  allowedRetentionClasses:['regulated-7y'],
  allowedPublication:['restricted']
}];

function policyContext(overrides:Record<string,unknown>={}):any{
  return{
    principalId:'agent:deploy',delegatedFrom:['human:alice'],capability:'deploy.release',risk:'system',
    resource:'project:payments/prod/service',environment:'prod',devicePosture:['managed','encrypted'],location:'IN',
    sessionId:'release:123',timestamp:'2026-10-07T12:00:00.000Z',
    approverPrincipalIds:['human:bob','human:carol'],actorPrincipalIds:['human:alice','agent:deploy'],
    evidenceClasses:['STATIC_ANALYSIS','INDEPENDENT_TEST'],independentVerifierPresent:true,
    estimatedActionCost:1.5,sessionCost:10,retentionClass:'regulated-7y',publication:'restricted',purpose:'release approved build',
    ...overrides
  };
}

test('R7 policy language enforces posture, time/location/session, quorum, separation, verifier/evidence, cost, retention and publication',()=>{
  const allowed=evaluateEnterprisePolicyLanguage(rules,policyContext());
  assert.equal(allowed.allowed,true);
  const explanation=explainEnterpriseMutation(policyContext(),allowed);
  assert.match(explanation.who,/agent:deploy/);
  assert.match(explanation.why,/approved build/);
  assert.match(explanation.where,/project:payments\/prod/);

  const denied=evaluateEnterprisePolicyLanguage(rules,policyContext({
    approverPrincipalIds:['human:alice'],
    devicePosture:['managed'],
    independentVerifierPresent:false,
    estimatedActionCost:8,
    publication:'public'
  }));
  assert.equal(denied.allowed,false);
  assert.match(denied.reasons.join(' '),/quorum|separation|required device posture|independent verifier|cost ceiling|publication/);
});

test('R7 historical policy simulation answers whether the proposed policy changes prior actions',async()=>{
  const result=await simulatePolicyAgainstHistory({
    roles:[{id:'release',capabilities:['deploy.*'],rootPrefixes:[],maxRisk:'system',environments:['prod'],projectPrefixes:['project:payments'],deviceGroups:[]}],
    bindings:[{id:'release-bind',principalId:'agent:deploy',roleId:'release',environment:'prod',enabled:true}],
    rules,
    actions:[
      {
        id:'a1',originalAllowed:true,
        basePermissions:{allowedCapabilities:['deploy.release'],allowedRoots:[],maxRisk:'system'},
        authorizationContext:{principalId:'agent:deploy',projectKey:'project:payments/api',environment:'prod'},
        policyContext:policyContext({independentVerifierPresent:false})
      },
      {
        id:'a2',originalAllowed:true,
        basePermissions:{allowedCapabilities:['deploy.release'],allowedRoots:[],maxRisk:'system'},
        authorizationContext:{principalId:'agent:deploy',projectKey:'project:payments/api',environment:'prod'},
        policyContext:policyContext()
      }
    ]
  });
  assert.equal(result.examined,2);
  assert.equal(result.changed,1);
  assert.equal(result.deltas[0]?.proposedAllowed,false);
  assert.equal(result.deltas[1]?.proposedAllowed,true);
});

test('R7 fleet/admin proves private deployment, regional posture, quotas, chargeback, legal hold and audit export',()=>{
  const admin=new EnterpriseAdminControlPlane({
    allowedRegions:['in-south-1'],requiredPosture:['managed','encrypted'],allowedDeploymentModes:['private-vpc','on-prem'],
    maxActiveDevices:10,monthlyBudget:100,monthlyActionQuota:1000,auditExportEnabled:true,legalHold:true
  });
  admin.registerDevice({deviceId:'device-prod-1',region:'in-south-1',posture:['managed','encrypted'],updateChannel:'stable',deploymentMode:'private-vpc',costCenter:'payments',active:true});
  assert.deepEqual(admin.validatePrivateDeployment('device-prod-1'),{ok:true,mode:'private-vpc',region:'in-south-1'});
  admin.recordUsage({principalId:'human:alice',costCenter:'payments',actions:20,cost:12.5,at:'2026-10-07T12:00:00.000Z'});
  assert.deepEqual(admin.chargeback('2026-10'),{payments:{actions:20,cost:12.5}});
  const exported=admin.exportAudit([{capability:'deploy.release',result:'success',risk:'system',details:{principalId:'human:alice',purpose:'release',region:'in-south-1'}}]);
  assert.equal(exported.legalHold,true);
  assert.equal(exported.eventCount,1);
  assert.match(exported.digest,/^[0-9a-f]{64}$/);
});
