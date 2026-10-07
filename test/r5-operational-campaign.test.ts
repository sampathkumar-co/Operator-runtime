import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  MINIMUM_R5_CERTIFICATION_POLICY,
  certifyR5OperationalCampaign,
  createR5OperationalCampaign,
  verifyR5OperationalCampaign,
  type R5FaultClass
} from '../src/core/r5-operational-campaign.ts';

const sha=(value:string)=>crypto.createHash('sha256').update(value,'utf8').digest('hex');
const sourceSha='c0377279b69dcd5b6817480776c1876f1889fb3a';
const faults:R5FaultClass[]=[
  'kill-at-transition','network-partition-reorder-duplication','reboot-sleep-clock-drift','disk-full',
  'permission-failure','corruption','large-event-growth','backup-during-mutation','verified-restore',
  'split-brain-worker','staged-update-rollback'
];

function body(overrides:Record<string,unknown>={}):any{
  return {
    schemaVersion:1,
    campaignId:'r5-prod-001',
    sourceSha,
    environmentDigest:sha('env'),
    productionLikeEnvironment:true,
    controlPlaneBackend:'postgresql',
    relayInstanceCount:3,
    sharedDurableState:true,
    startedAt:'2026-10-01T00:00:00.000Z',
    endedAt:'2026-10-04T00:05:00.000Z',
    traceCoverageRate:1,
    multiInstanceStateSafe:true,
    restoreCoherent:true,
    stagedUpdateRollbackProven:true,
    metrics:{
      operation:{traces:10000,completed:9998,blocked:1,failed:1,uncertain:0,verified:9998,completionRate:.9998,verificationRate:.9998,falseCompletionCount:0,p50CompletionMs:250,p95CompletionMs:1500},
      crashFreeSessionRate:.9999,
      updateSuccessRate:1,
      controlPlaneAvailability:.9999,
      reconnectSuccessRate:.999,
      p95DispatchMs:500,
      p95VerificationMs:1000,
      queueDepth:20,
      p95DeliveryAgeMs:800,
      p95ReconciliationMs:2500,
      stateBytes:100_000_000,
      retentionViolationCount:0
    },
    policy:{...MINIMUM_R5_CERTIFICATION_POLICY},
    faults:faults.map((fault)=>({fault,exercised:true,passed:true,evidenceDigests:[sha('fault:'+fault)]})),
    externalEvidenceDigests:[sha('trace'),sha('restore'),sha('update'),sha('postgres')],
    ...overrides
  };
}

test('R5 operational campaign certifies only a full 72-hour multi-instance production-like run',()=>{
  const campaign=createR5OperationalCampaign(body());
  const report=certifyR5OperationalCampaign(campaign);
  assert.equal(report.status,'CERTIFIED');
  assert.equal(report.soak24hPassed,true);
  assert.equal(report.soak72hPassed,true);
  assert.equal(report.sloHealthy,true);
  assert.equal(report.allFaultClassesPassed,true);
  assert.match(report.reportDigest,/^[0-9a-f]{64}$/);
});

test('R5 campaign does not promote a short soak',()=>{
  const campaign=createR5OperationalCampaign(body({endedAt:'2026-10-02T00:01:00.000Z'}));
  const report=certifyR5OperationalCampaign(campaign);
  assert.equal(report.soak24hPassed,true);
  assert.equal(report.soak72hPassed,false);
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.match(report.reasons.join(' '),/72-hour/);
});

test('R5 campaign requires every reliability-lab fault class with evidence',()=>{
  const incomplete=body();
  incomplete.faults=incomplete.faults.filter((item:any)=>item.fault!=='disk-full');
  const report=certifyR5OperationalCampaign(createR5OperationalCampaign(incomplete));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.equal(report.allFaultClassesPassed,false);
  assert.match(report.reasons.join(' '),/disk-full/);
});

test('R5 campaign refuses a weaker-than-minimum SLO policy',()=>{
  const weak=body();
  weak.policy={...MINIMUM_R5_CERTIFICATION_POLICY,minControlPlaneAvailability:.9};
  const campaign=createR5OperationalCampaign(weak);
  assert.throws(()=>certifyR5OperationalCampaign(campaign),/weaker than certification minimum/);
});

test('R5 campaign refuses false completion even when other metrics are healthy',()=>{
  const bad=body();
  bad.metrics={...bad.metrics,operation:{...bad.metrics.operation,falseCompletionCount:1}};
  const report=certifyR5OperationalCampaign(createR5OperationalCampaign(bad));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.match(report.reasons.join(' '),/FALSE_COMPLETION/);
});

test('R5 campaign digest detects evidence tampering',()=>{
  const campaign=createR5OperationalCampaign(body());
  assert.equal(verifyR5OperationalCampaign(campaign),true);
  const tampered=structuredClone(campaign);
  tampered.body.restoreCoherent=false;
  assert.equal(verifyR5OperationalCampaign(tampered),false);
});
