import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { DeviceRegistryStore } from '../src/core/device-registry.ts';
import { DeviceRoutingStore } from '../src/core/device-routing.ts';
import { DevicePoolScheduler } from '../src/core/device-pool.ts';

async function setup(t:test.TestContext) {
  const state=await fs.mkdtemp(path.join(os.tmpdir(),'devicepool-strict-recovery-'));
  const idRoot=await fs.mkdtemp(path.join(os.tmpdir(),'devicepool-strict-identity-'));
  t.after(()=>Promise.all([state,idRoot].map(p=>fs.rm(p,{recursive:true,force:true}))));
  const registry=new DeviceRegistryStore(state), routing=new DeviceRoutingStore(state,registry);
  const peer=await new DeviceIdentityStore(idRoot,{platform:'linux'}).loadOrCreate('audit-peer');
  await registry.registerVerifiedPeer(peer);
  const scheduler=new DevicePoolScheduler(state,registry,routing);
  const sessionId=crypto.randomUUID();
  const advertisements=[{deviceId:peer.deviceId,sessionId,capabilities:['file.read'],observedAt:new Date().toISOString(),cpuSlots:4,memoryMb:16384,gpu:false,tags:['stable'],activeJobs:0,maxConcurrentJobs:2}];
  const request={workloadKey:'job:audit',projectKey:'project:source',requiredCapabilities:['file.read'],requiredTags:['stable'],slots:1};
  const reservation=await scheduler.reserve(request,advertisements);
  return {state,scheduler,request,advertisements,reservation};
}
for(const field of ['id','workloadKey','projectKey','deviceId','sessionId','allocationRequestDigest','acquiredAt','heartbeatAt','expiresAt','requiredCapabilities','requiredTags'] as const) {
  test('durable capacity recovery rejects coerced '+field,async t=>{
    const {state,reservation}=await setup(t),file=path.join(state,'device-pool.json');
    const parsed=JSON.parse(await fs.readFile(file,'utf8'));
    const item=parsed.reservations[0];
    if(field==='requiredCapabilities'||field==='requiredTags') item[field][0]=[item[field][0]];
    else item[field]=[item[field]];
    const bad=JSON.stringify(parsed);
    await fs.writeFile(file,bad);
    const registry=new DeviceRegistryStore(state),routing=new DeviceRoutingStore(state,registry);
    await assert.rejects(new DevicePoolScheduler(state,registry,routing).list(),
      (e:any)=>['DEVICE_POOL_INPUT_INVALID','DEVICE_POOL_STATE_CORRUPT'].includes(e?.code));
    assert.equal(await fs.readFile(file,'utf8'),bad);
  });
}
test('scheduler never downgrades malformed resource requirements or accepts coerced reservation proof',async t=>{
  const {scheduler,request,advertisements,reservation}=await setup(t);
  const invalid=[
    {...request,requireGpu:'true'},
    {...request,slots:'1'},
    {...request,requiredCapabilities:[['file.read']]},
    {...request,workloadKey:['job:audit']},
  ];
  for(const input of invalid){
    await assert.rejects(scheduler.reserve(input as any,advertisements), (e:any)=>e?.code==='DEVICE_POOL_INPUT_INVALID');
  }
  await assert.rejects(scheduler.reserve({...request,workloadKey:'new',slots:1},[{...advertisements[0],gpu:'true'}] as any),
    (e:any)=>e?.code==='DEVICE_POOL_INPUT_INVALID');
  await assert.rejects(scheduler.releasePrepared(reservation.id,[reservation.allocationRequestDigest!] as any),
    (e:any)=>e?.code==='DEVICE_POOL_ALLOCATION_PROOF_INVALID');
});
