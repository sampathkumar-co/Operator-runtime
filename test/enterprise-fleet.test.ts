import assert from 'node:assert/strict';
import test from 'node:test';
import { assessEnterpriseFleetDevice, summarizeEnterpriseFleet } from '../src/core/enterprise-fleet.ts';

const policy={
  allowedPlatforms:['win32'] as const,
  minimumRuntimeVersion:'2.0.5',
  allowedUpdateChannels:['stable','beta'] as const,
  requireManaged:true,
  requireSecureBoot:true,
  requireDiskEncryption:true,
  requireRuntimeSignature:true,
  maximumOfflineMs:60_000,
  allowedSourceCommits:['a'.repeat(40)]
};

function device(overrides:any={}):any{return{
  schemaVersion:1,deviceId:'device:1',deviceName:'Workstation',platform:'win32',arch:'x64',
  runtimeVersion:'2.0.5',sourceCommit:'a'.repeat(40),updateChannel:'stable',managed:true,
  secureBoot:true,diskEncryption:true,runtimeSignatureVerified:true,lastSeenAt:'2026-10-07T00:00:30.000Z',
  revoked:false,labels:['prod'],...overrides
};}

test('enterprise fleet admits only compliant live trusted devices',()=>{
  const assessment=assessEnterpriseFleetDevice({device:device(),policy:policy as any,now:'2026-10-07T00:01:00.000Z'});
  assert.equal(assessment.status,'COMPLIANT');
  assert.equal(assessment.executionEligible,true);

  const bad=assessEnterpriseFleetDevice({device:device({secureBoot:'unknown',runtimeSignatureVerified:false}),policy:policy as any,now:'2026-10-07T00:01:00.000Z'});
  assert.equal(bad.status,'NONCOMPLIANT');
  assert.equal(bad.executionEligible,false);
  assert.ok(bad.reasons.includes('SECURE_BOOT_UNKNOWN'));
  assert.ok(bad.reasons.includes('RUNTIME_SIGNATURE_UNVERIFIED'));
});

test('offline and revoked devices are never execution eligible',()=>{
  const summary=summarizeEnterpriseFleet({
    devices:[device({deviceId:'device:offline',lastSeenAt:'2026-10-06T23:00:00.000Z'}),device({deviceId:'device:revoked',revoked:true})],
    policy:policy as any,now:'2026-10-07T00:01:00.000Z'
  });
  assert.equal(summary.offline,1);
  assert.equal(summary.revoked,1);
  assert.equal(summary.executionEligible,0);
});

test('prerelease does not satisfy an equal stable minimum version',()=>{
  const assessment=assessEnterpriseFleetDevice({
    device:device({runtimeVersion:'2.0.5-canary.1',updateChannel:'beta'}),
    policy:policy as any,
    now:'2026-10-07T00:01:00.000Z'
  });
  assert.equal(assessment.executionEligible,false);
  assert.ok(assessment.reasons.includes('RUNTIME_VERSION_TOO_OLD'));
});
