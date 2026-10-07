import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  certifyR7EnterpriseAcceptanceCampaign,
  createR7EnterpriseAcceptanceCampaign,
  verifyR7EnterpriseAcceptanceCampaign
} from '../src/core/r7-enterprise-acceptance.ts';

const sha=(v:string)=>crypto.createHash('sha256').update(v,'utf8').digest('hex');
const sourceSha='23a1946e7e0b86aa28dc225b0afb57f38808e33f';

function body(overrides:Record<string,unknown>={}):any{
  return {
    schemaVersion:1,
    sourceSha,
    campaignId:'r7-enterprise-001',
    organizationId:'org:external-acme',
    operatorPrincipalId:'human:operator',
    independentVerifierId:'human:auditor',
    externalIdentityProvider:true,
    scimProvisioned:true,
    scimRoleMapped:true,
    scimDeactivationVerified:true,
    authorityLeaseLifecyclePassed:true,
    approvalQuorumPassed:true,
    separationOfDutiesPassed:true,
    devicePostureEnforced:true,
    budgetQuotaEnforced:true,
    mutationCount:250,
    mutationExplanationCoverageRate:1,
    policyReplayActionCount:250,
    policyReplayCompleted:true,
    privateDeployment:{
      mode:'private-vpc',
      publicIngressDenied:true,
      controlPlanePrivate:true,
      independentProbePassed:true,
      evidenceDigests:[sha('private-probe'),sha('routing-proof')]
    },
    audit:{
      exportDigest:sha('audit-export'),
      independentlyVerified:true,
      legalHoldVerified:true,
      regionalControlsVerified:true,
      chargebackVerified:true,
      evidenceDigests:[sha('audit-review'),sha('legal-hold-review')]
    },
    evidenceDigests:[sha('sso'),sha('policy-replay'),sha('admin-controls'),sha('audit-export')],
    ...overrides
  };
}

test('R7 enterprise campaign certifies an independently verified governed organization',()=>{
  const campaign=createR7EnterpriseAcceptanceCampaign(body());
  const report=certifyR7EnterpriseAcceptanceCampaign(campaign);
  assert.equal(report.status,'CERTIFIED');
  assert.equal(report.mutationExplanationCoverageRate,1);
  assert.equal(report.policyReplayActionCount,250);
  assert.equal(report.privateDeploymentPassed,true);
  assert.equal(report.auditAcceptancePassed,true);
  assert.match(report.reportDigest,/^[0-9a-f]{64}$/);
});

test('R7 requires an independent verifier distinct from the operating principal',()=>{
  const bad=body({independentVerifierId:'human:operator'});
  const report=certifyR7EnterpriseAcceptanceCampaign(createR7EnterpriseAcceptanceCampaign(bad));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.match(report.reasons.join(' '),/independent verifier/);
});

test('R7 requires external SSO and complete SCIM provision-role-deactivate lifecycle',()=>{
  const bad=body({externalIdentityProvider:false,scimDeactivationVerified:false});
  const report=certifyR7EnterpriseAcceptanceCampaign(createR7EnterpriseAcceptanceCampaign(bad));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.match(report.reasons.join(' '),/SSO\/SCIM/);
});

test('R7 requires 100 percent mutation explanation coverage and meaningful policy replay',()=>{
  const bad=body({mutationExplanationCoverageRate:.99,policyReplayActionCount:99});
  const report=certifyR7EnterpriseAcceptanceCampaign(createR7EnterpriseAcceptanceCampaign(bad));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.match(report.reasons.join(' '),/explanation coverage|policy simulation/);
});

test('R7 private deployment must be independently probed and deny public ingress',()=>{
  const bad=body();
  bad.privateDeployment={...bad.privateDeployment,publicIngressDenied:false,independentProbePassed:false};
  const report=certifyR7EnterpriseAcceptanceCampaign(createR7EnterpriseAcceptanceCampaign(bad));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.equal(report.privateDeploymentPassed,false);
});

test('R7 audit acceptance requires independent digest verification and governance controls',()=>{
  const bad=body();
  bad.audit={...bad.audit,independentlyVerified:false,legalHoldVerified:false};
  const report=certifyR7EnterpriseAcceptanceCampaign(createR7EnterpriseAcceptanceCampaign(bad));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.equal(report.auditAcceptancePassed,false);
});

test('R7 campaign digest detects evidence tampering',()=>{
  const campaign=createR7EnterpriseAcceptanceCampaign(body());
  assert.equal(verifyR7EnterpriseAcceptanceCampaign(campaign),true);
  const tampered=structuredClone(campaign);
  tampered.body.budgetQuotaEnforced=false;
  assert.equal(verifyR7EnterpriseAcceptanceCampaign(tampered),false);
});
