import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { projectDoctorOnboardingEvidence } from '../src/core/control-center-doctor-evidence.ts';
import { PRODUCT_VERSION } from '../src/core/product-identity.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

test('C10 doctor proof requires literal, fresh, version-bound trusted evidence', () => {
  const now = new Date('2026-10-26T04:00:00.000Z');
  const proof = { passed:true, observedAt:now.toISOString(), productVersion: PRODUCT_VERSION };
  const pass = projectDoctorOnboardingEvidence(proof, PRODUCT_VERSION, now);
  assert.deepEqual(pass, { healthy:true, status:'PASS', source:'TRUSTED_DOCTOR_PROBE' });
  for (const input of [
    null, undefined, true,
    { ...proof, passed:'true' },
    { ...proof, passed:[true] },
    { ...proof, observedAt:[proof.observedAt] },
    { ...proof, observedAt:'garbage' },
    { ...proof, productVersion:[PRODUCT_VERSION] }
  ]) {
    assert.deepEqual(projectDoctorOnboardingEvidence(input,PRODUCT_VERSION,now),
      { healthy:false,status:'UNVERIFIED',source:'NONE' });
  }
  assert.equal(projectDoctorOnboardingEvidence({ ...proof, passed:false },PRODUCT_VERSION,now).status,'FAILED');
  assert.equal(projectDoctorOnboardingEvidence({ ...proof, productVersion:'0.0.0' },PRODUCT_VERSION,now).status,'VERSION_MISMATCH');
  assert.equal(projectDoctorOnboardingEvidence({ ...proof, observedAt:'2026-10-26T03:50:00.000Z' },PRODUCT_VERSION,now).status,'STALE');
  assert.equal(projectDoctorOnboardingEvidence({ ...proof, observedAt:'2026-10-26T04:01:00.000Z' },PRODUCT_VERSION,now).status,'STALE');
});

test('C10 authenticated HTTP availability never automatically certifies CLI doctor', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-c10-doctor-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const runtime=createRuntime({allowedRoots:[root],allowedExecutables:['node']});
  const token='u'.repeat(64);
  const agent=createLocalAgentServer({
    runtime, token,
    permissions:{allowedCapabilities:['computer.inspect'],allowedRoots:[root]}
  });
  t.after(()=>Promise.allSettled([agent.close(),runtime.close()]));
  const {port}=await agent.listen('127.0.0.1',0);
  const base='http://127.0.0.1:'+port;
  const health=await fetch(base+'/health');
  assert.equal(health.status,200);
  const response=await fetch(base+'/v1/control-center/onboarding',
    {headers:{authorization:'Bearer '+token}});
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.model.nextStep,'DOCTOR');
  assert.equal(result.model.steps.find(s=>s.id==='DOCTOR').status,'READY');
  assert.equal(result.model.completed,false);
  assert.equal(result.evidence.doctorHealthy,'UNVERIFIED');
  assert.equal(result.evidence.doctorEvidenceSource,'NONE');
  assert.equal((await fetch(base+'/v1/control-center/onboarding')).status,401);
});
