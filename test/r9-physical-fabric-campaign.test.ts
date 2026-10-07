import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  certifyR9PhysicalFabricCampaign,
  createR9PhysicalFabricCampaign,
  verifyR9PhysicalFabricCampaign,
  type R9DistributedFaultEvidence
} from '../src/core/r9-physical-fabric-campaign.ts';

const sha=(v:string)=>crypto.createHash('sha256').update(v,'utf8').digest('hex');
const sourceSha='84145cdcddf9736707ffe9970add63bc7fe879a4';
const faults:R9DistributedFaultEvidence['fault'][]=[
  'worker-disconnect','worker-crash','worker-replacement','lease-expiry','resource-conflict',
  'control-plane-restart','stale-result','network-partition','duplicate-delivery'
];

function body(overrides:Record<string,unknown>={}):any{
  return {
    schemaVersion:1,
    sourceSha,
    campaignId:'r9-physical-001',
    objectiveId:'objective-r9-001',
    authorityDigest:sha('authority'),
    machines:[
      {
        machineId:'physical-a',physicalMachine:true,platform:'windows',
        hardwareAttestationDigest:sha('hardware-a'),runtimeInstanceId:'runtime-a',
        sourceCheckoutSha:sourceSha,evidenceDigests:[sha('machine-a-evidence')]
      },
      {
        machineId:'physical-b',physicalMachine:true,platform:'windows',
        hardwareAttestationDigest:sha('hardware-b'),runtimeInstanceId:'runtime-b',
        sourceCheckoutSha:sourceSha,evidenceDigests:[sha('machine-b-evidence')]
      }
    ],
    workerCount:4,
    workUnitCount:20,
    verifiedWorkUnitCount:20,
    independentVerifierCount:2,
    crossMachineVerificationCount:20,
    lineageCoverageRate:1,
    artifactRecoveryRate:1,
    artifactOnlyExchange:true,
    rawSecretExchangeCount:0,
    leaseEpochMonotonic:true,
    staleResultAcceptedCount:0,
    unfencedResourceConflictCount:0,
    faultEvidence:faults.map((fault)=>({
      fault,exercised:true,recovered:true,splitBrainCount:0,duplicateExecutionCount:0,
      authorityViolationCount:0,evidenceLossCount:0,evidenceDigests:[sha('fault:'+fault)]
    })),
    finalObjectiveVerified:true,
    externalEvidenceDigests:[sha('objective-proof'),sha('lineage-report'),sha('cross-machine-log')],
    ...overrides
  };
}

test('R9 certifies a two-physical-machine objective with cross-machine verification and zero trust failures',()=>{
  const campaign=createR9PhysicalFabricCampaign(body());
  const report=certifyR9PhysicalFabricCampaign(campaign);
  assert.equal(report.status,'CERTIFIED');
  assert.equal(report.physicalMachineCount,2);
  assert.equal(report.verifiedWorkUnitRate,1);
  assert.equal(report.lineageCoverageRate,1);
  assert.equal(report.artifactRecoveryRate,1);
  assert.equal(report.allRequiredFaultsPassed,true);
  assert.equal(report.splitBrainCount,0);
  assert.equal(report.duplicateExecutionCount,0);
  assert.equal(report.authorityViolationCount,0);
  assert.equal(report.evidenceLossCount,0);
  assert.match(report.reportDigest,/^[0-9a-f]{64}$/);
});

test('R9 does not count two logical workers on one physical machine as multi-machine acceptance',()=>{
  const bad=body();
  bad.machines[1].machineId='physical-a';
  assert.throws(()=>createR9PhysicalFabricCampaign(bad),/identities must be unique/);
});

test('R9 requires exact source checkout on every physical machine',()=>{
  const bad=body();
  bad.machines[1].sourceCheckoutSha='a'.repeat(40);
  const report=certifyR9PhysicalFabricCampaign(createR9PhysicalFabricCampaign(bad));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.match(report.reasons.join(' '),/certification source SHA/);
});

test('R9 requires cross-machine independent verification for every verified work unit',()=>{
  const report=certifyR9PhysicalFabricCampaign(createR9PhysicalFabricCampaign(body({crossMachineVerificationCount:19})));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.match(report.reasons.join(' '),/another physical machine/);
});

test('R9 rejects secret exchange, stale acceptance, non-monotonic epochs, or unfenced conflicts',()=>{
  const report=certifyR9PhysicalFabricCampaign(createR9PhysicalFabricCampaign(body({
    artifactOnlyExchange:false,rawSecretExchangeCount:1,leaseEpochMonotonic:false,
    staleResultAcceptedCount:1,unfencedResourceConflictCount:1
  })));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.match(report.reasons.join(' '),/artifact-only|raw secret|lease epochs|stale distributed|resource conflict/);
});

test('R9 requires all distributed failure classes to recover without split brain, duplicates, authority violations, or evidence loss',()=>{
  const bad=body();
  bad.faultEvidence=bad.faultEvidence.filter((item:any)=>item.fault!=='network-partition');
  bad.faultEvidence.find((item:any)=>item.fault==='worker-crash').duplicateExecutionCount=1;
  const report=certifyR9PhysicalFabricCampaign(createR9PhysicalFabricCampaign(bad));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.equal(report.allRequiredFaultsPassed,false);
  assert.equal(report.duplicateExecutionCount,1);
  assert.match(report.reasons.join(' '),/network-partition|duplicate execution/);
});

test('R9 campaign digest detects machine or fault evidence tampering',()=>{
  const campaign=createR9PhysicalFabricCampaign(body());
  assert.equal(verifyR9PhysicalFabricCampaign(campaign),true);
  const tampered=structuredClone(campaign);
  tampered.body.faultEvidence[0]!.evidenceLossCount=1;
  assert.equal(verifyR9PhysicalFabricCampaign(tampered),false);
});
