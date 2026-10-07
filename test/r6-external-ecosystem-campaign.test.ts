import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  certifyR6ExternalEcosystemCampaign,
  createR6ExternalEcosystemCampaign,
  verifyR6ExternalEcosystemCampaign
} from '../src/core/r6-external-ecosystem-campaign.ts';

const sha=(v:string)=>crypto.createHash('sha256').update(v,'utf8').digest('hex');
const sourceSha='c0377279b69dcd5b6817480776c1876f1889fb3a';
const trust=sha('canonical-trust-semantics');

function integration(id:string,publisher:string,ecosystem:string,adapter:'typescript-sdk'|'python-sdk'|'openapi'|'webhook'){
  return {
    integrationId:id,
    externalPublisherId:publisher,
    externalDeveloper:true,
    agentEcosystem:ecosystem,
    adapter,
    coreChangesRequired:false,
    conformancePassed:true,
    adversarialPassed:true,
    unsafeCapabilityDenied:true,
    trustSemanticsDigest:trust,
    evidenceDigests:[sha('evidence:'+id)]
  };
}
function body(overrides:Record<string,unknown>={}):any{
  return {
    schemaVersion:1,
    sourceSha,
    campaignId:'r6-external-001',
    canonicalTrustSemanticsDigest:trust,
    integrations:[
      integration('i1','publisher-a','ecosystem-a','typescript-sdk'),
      integration('i2','publisher-b','ecosystem-b','python-sdk'),
      integration('i3','publisher-c','ecosystem-c','openapi')
    ],
    publisherLifecycle:{
      externalPublisherId:'publisher-a',
      capabilityId:'capability.demo',
      signedPackageDigest:sha('package'),
      reproducibleBuildDigest:sha('build'),
      published:true,
      qualityMetricsObserved:true,
      revoked:true,
      revocationPropagated:true,
      postRevocationExecutionDenied:true,
      evidenceDigests:[sha('publish'),sha('monitor'),sha('revoke')]
    },
    ...overrides
  };
}

test('R6 external ecosystem campaign certifies three independent ecosystems with one trust model',()=>{
  const campaign=createR6ExternalEcosystemCampaign(body());
  const report=certifyR6ExternalEcosystemCampaign(campaign);
  assert.equal(report.status,'CERTIFIED');
  assert.equal(report.independentIntegrationCount,3);
  assert.equal(report.distinctAgentEcosystems,3);
  assert.equal(report.distinctAdapters,3);
  assert.equal(report.allTrustSemanticsIdentical,true);
  assert.equal(report.publicPublisherLifecyclePassed,true);
});

test('R6 does not count integrations that needed core changes or failed adversarial certification',()=>{
  const bad=body();
  bad.integrations[1].coreChangesRequired=true;
  bad.integrations[2].adversarialPassed=false;
  const report=certifyR6ExternalEcosystemCampaign(createR6ExternalEcosystemCampaign(bad));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.equal(report.independentIntegrationCount,1);
  assert.match(report.reasons.join(' '),/three qualifying/);
});

test('R6 requires distinct publishers and distinct agent ecosystems',()=>{
  const bad=body();
  bad.integrations[1].externalPublisherId='publisher-a';
  bad.integrations[2].agentEcosystem='ecosystem-a';
  const report=certifyR6ExternalEcosystemCampaign(createR6ExternalEcosystemCampaign(bad));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.match(report.reasons.join(' '),/publishers|ecosystems/);
});

test('R6 rejects trust-semantic drift across external integrations',()=>{
  const bad=body();
  bad.integrations[2].trustSemanticsDigest=sha('different-trust');
  const report=certifyR6ExternalEcosystemCampaign(createR6ExternalEcosystemCampaign(bad));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.equal(report.allTrustSemanticsIdentical,false);
  assert.match(report.reasons.join(' '),/trust semantics/);
});

test('R6 requires public publisher revocation to propagate and block execution',()=>{
  const bad=body();
  bad.publisherLifecycle.revocationPropagated=false;
  bad.publisherLifecycle.postRevocationExecutionDenied=false;
  const report=certifyR6ExternalEcosystemCampaign(createR6ExternalEcosystemCampaign(bad));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.equal(report.publicPublisherLifecyclePassed,false);
});

test('R6 campaign digest detects evidence tampering',()=>{
  const campaign=createR6ExternalEcosystemCampaign(body());
  assert.equal(verifyR6ExternalEcosystemCampaign(campaign),true);
  const tampered=structuredClone(campaign);
  tampered.body.integrations[0]!.coreChangesRequired=true;
  assert.equal(verifyR6ExternalEcosystemCampaign(tampered),false);
});
