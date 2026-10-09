import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AccountDeviceRegistry } from '../src/core/account-device-registry.ts';
import type { DeviceRegistryStore } from '../src/core/device-registry.ts';

async function temp(t:test.TestContext){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'operator-account-multi-owner-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 return dir;
}
function fixture(dir:string,deviceId=crypto.randomUUID()){
 const devices={listDevices:async()=>[{deviceId,status:'active'}]} as unknown as DeviceRegistryStore;
 return {deviceId,registry:()=>new AccountDeviceRegistry(dir,devices)};
}
test('eight independent account registry writers preserve every principal',async t=>{
 const dir=await temp(t);
 const {registry}=fixture(dir);
 const accounts=await Promise.all(Array.from({length:8},(_,i)=>registry().resolveOrCreateAccount({
  issuer:'https://issuer.example',subject:'principal-'+i
 })));
 assert.equal(new Set(accounts.map(a=>a.accountId)).size,8);
 const raw=JSON.parse(await fs.readFile(path.join(dir,'account-devices.json'),'utf8'));
 assert.equal(raw.accounts.length,8);
});
test('independent registries cannot bind the same active device to two accounts',async t=>{
 const dir=await temp(t);
 const {registry,deviceId}=fixture(dir);
 const a=await registry().resolveOrCreateAccount({issuer:'issuer',subject:'a'});
 const b=await registry().resolveOrCreateAccount({issuer:'issuer',subject:'b'});
 const results=await Promise.allSettled([
   registry().bindDevice(a.accountId,deviceId),
   registry().bindDevice(b.accountId,deviceId)
 ]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
test('an independent account disable must wait for an in-flight authority lease',async t=>{
 const dir=await temp(t);
 const {registry,deviceId}=fixture(dir);
 const owner=await registry().resolveOrCreateAccount({issuer:'issuer',subject:'owner'});
 const membership=await registry().bindDevice(owner.accountId,deviceId);
 let enter!:()=>void, finish!:()=>void;
 const entered=new Promise<void>(resolve=>{enter=resolve});
 const gate=new Promise<void>(resolve=>{finish=resolve});
 const holder=registry().withActiveAuthorityLease({
  accountId:owner.accountId,deviceId,generation:membership.authorityGeneration
 },async()=>{enter();await gate;return 'authorized'});
 await entered;
 const disable=registry().disableAccount(owner.accountId,'authorized disable');
 try {
   const raced=await Promise.race([disable.then(()=>true),delay(80).then(()=>false)]);
   assert.equal(raced,false,'an account cannot disable while an earlier authorized operation owns its lease');
 } finally { finish(); }
 assert.equal(await holder,'authorized');
 assert.equal((await disable).status,'disabled');
 await assert.rejects(registry().withActiveAuthorityLease({
  accountId:owner.accountId,deviceId,generation:membership.authorityGeneration
 },async()=>true),(error:any)=>error?.code==='ACCOUNT_AUTHORITY_REVOKED');
});

test('independent erasure workers own a single durable cleanup sequence',async t=>{
 const dir=await temp(t);
 const {registry,deviceId}=fixture(dir);
 const account=await registry().resolveOrCreateAccount({issuer:'issuer',subject:'erase-owner'});
 await registry().bindDevice(account.accountId,deviceId);
 const count=new Map<string,number>();
 let entered!:()=>void;
 const inside=new Promise<void>(resolve=>{entered=resolve});
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve});
 const cleanup=async (phase:string)=>{
   count.set(phase,(count.get(phase)||0)+1);
   if(phase==='LIVE_CONNECTIONS_CLOSED'){entered();await gate;}
 };
 const first=new AccountDeviceRegistry(dir,{
   listDevices:async()=>[{deviceId,status:'active'}],
   unregisterActiveDevice:async()=>{}
 } as unknown as DeviceRegistryStore,{onErasurePhase:cleanup});
 const second=new AccountDeviceRegistry(dir,{
   listDevices:async()=>[{deviceId,status:'active'}],
   unregisterActiveDevice:async()=>{}
 } as unknown as DeviceRegistryStore,{onErasurePhase:cleanup});
 const erasingA=first.eraseAccount(account.accountId);
 await inside;
 const erasingB=second.eraseAccount(account.accountId);
 await delay(60);
 assert.equal(count.get('LIVE_CONNECTIONS_CLOSED'),1);
 release();
 const results=await Promise.all([erasingA,erasingB]);
 assert.equal(results[0].accountId,account.accountId);
 assert.equal(results[1].accountId,account.accountId);
 for(const phase of ['LIVE_CONNECTIONS_CLOSED','ROUTING_DISABLED','DELIVERY_SESSION_RESULT_PURGE'])
   assert.equal(count.get(phase),1,'cleanup phase '+phase+' may have exactly one active owner');
});

test('separate operating-system processes retain independent account identities',async t=>{
 const dir=await temp(t);
 const {execFile}=await import('node:child_process');
 const {promisify}=await import('node:util');
 const {pathToFileURL}=await import('node:url');
 const uri=pathToFileURL(path.resolve('src/core/account-device-registry.ts')).href;
 const script=`import {AccountDeviceRegistry} from ${JSON.stringify(uri)};
const s=new AccountDeviceRegistry(process.argv[1],{listDevices:async()=>[]});
await s.resolveOrCreateAccount({issuer:'issuer',subject:process.argv[2]});`;
 await Promise.all(Array.from({length:4},(_,i)=>promisify(execFile)(process.execPath,
   ['--experimental-strip-types','--input-type=module','-e',script,dir,'proc-'+i],
   {cwd:process.cwd(),windowsHide:true,timeout:30000})));
 const state=JSON.parse(await fs.readFile(path.join(dir,'account-devices.json'),'utf8'));
 assert.equal(state.accounts.length,4);
});

test('concurrent erasure resumes run cleanup phases only once across instances',async t=>{
 const dir=await temp(t);
 const deviceId=crypto.randomUUID();
 let registered=true;
 const devices={
   listDevices:async()=>registered?[{deviceId,status:'active'}]:[],
   unregisterActiveDevice:async()=>{registered=false}
 } as unknown as DeviceRegistryStore;
 let entered!:()=>void, finish!:()=>void;
 const phaseEntered=new Promise<void>(resolve=>{entered=resolve});
 const phaseGate=new Promise<void>(resolve=>{finish=resolve});
 let livePhaseCalls=0, purgeCalls=0;
 const registry=()=>new AccountDeviceRegistry(dir,devices,{
   onErasurePhase:async (phase)=>{
     if(phase==='LIVE_CONNECTIONS_CLOSED'){
       livePhaseCalls+=1;
       if(livePhaseCalls===1){entered();await phaseGate;}
     }
     if(phase==='DELIVERY_SESSION_RESULT_PURGE')purgeCalls+=1;
   }
 });
 const owner=await registry().resolveOrCreateAccount({issuer:'issuer',subject:'erasure'});
 await registry().bindDevice(owner.accountId,deviceId);
 const first=registry().eraseAccount(owner.accountId);
 await phaseEntered;
 const second=registry().eraseAccount(owner.accountId);
 try {
   assert.equal(await Promise.race([second.then(()=>true),delay(80).then(()=>false)]),false);
 } finally {finish();}
 await Promise.all([first,second]);
 assert.equal(livePhaseCalls,1);
 assert.equal(purgeCalls,1);
 const state=JSON.parse(await fs.readFile(path.join(dir,'account-devices.json'),'utf8'));
 assert.equal(state.erasures.filter((e:{phase:string})=>e.phase==='COMPLETE').length,1);
});
test('separate OS processes preserve each account principal',async t=>{
 const dir=await temp(t);
 const {execFile}=await import('node:child_process');
 const {promisify}=await import('node:util');
 const {pathToFileURL}=await import('node:url');
 const exec=promisify(execFile);
 const uri=pathToFileURL(path.resolve('src/core/account-device-registry.ts')).href;
 const script=`import {AccountDeviceRegistry} from ${JSON.stringify(uri)};
await new AccountDeviceRegistry(process.argv[1],{}).resolveOrCreateAccount({
 issuer:'process-issuer',subject:process.argv[2]
});`;
 await Promise.all(Array.from({length:4},(_,i)=>exec(process.execPath,[
   '--experimental-strip-types','--input-type=module','-e',script,dir,'principal-'+i
 ],{cwd:process.cwd(),timeout:30000,windowsHide:true})));
 const state=JSON.parse(await fs.readFile(path.join(dir,'account-devices.json'),'utf8'));
 assert.equal(state.accounts.length,4);
});


test('erasure retains a high-water generation fence without preserving erased membership history', async (t) => {
  const dir = await temp(t);
  const deviceId = crypto.randomUUID();
  const devices = {
    listDevices: async () => [{ deviceId, status: 'active' }],
    unregisterActiveDevice: async () => undefined
  } as unknown as DeviceRegistryStore;
  const store = () => new AccountDeviceRegistry(dir, devices);
  const ownerA = await store().resolveOrCreateAccount({ issuer: 'issuer', subject: 'erased-owner' });
  const first = await store().bindDevice(ownerA.accountId, deviceId);
  assert.equal(first.authorityGeneration, 1);
  await store().eraseAccount(ownerA.accountId);

  const afterErase = JSON.parse(await fs.readFile(path.join(dir, 'account-devices.json'), 'utf8'));
  assert.equal(afterErase.memberships.some((entry: any) => entry.accountId === ownerA.accountId), false);
  assert.equal(afterErase.accounts.some((entry: any) => entry.accountId === ownerA.accountId), false);
  assert.equal(afterErase.authorityGenerationFloor, 1);

  const ownerB = await store().resolveOrCreateAccount({ issuer: 'issuer', subject: 'new-owner' });
  const second = await store().bindDevice(ownerB.accountId, deviceId);
  assert.equal(second.authorityGeneration, 2);
  await assert.rejects(store().withActiveAuthorityLease({
    accountId: ownerB.accountId, deviceId, generation: first.authorityGeneration
  }, async () => 'stale'), (error: any) => error?.code === 'ACCOUNT_AUTHORITY_REVOKED');

  await store().eraseAccount(ownerB.accountId);
  const ownerC = await store().resolveOrCreateAccount({ issuer: 'issuer', subject: 'third-owner' });
  const third = await store().bindDevice(ownerC.accountId, deviceId);
  assert.equal(third.authorityGeneration, 3);
});

test('multiple device generations never fall below a completed erasure fence', async (t) => {
  const dir = await temp(t);
  const deviceA = crypto.randomUUID();
  const deviceB = crypto.randomUUID();
  const devices = {
    listDevices: async () => [{ deviceId: deviceA, status: 'active' }, { deviceId: deviceB, status: 'active' }],
    unregisterActiveDevice: async () => undefined
  } as unknown as DeviceRegistryStore;
  const registry = () => new AccountDeviceRegistry(dir, devices);
  const firstOwner = await registry().resolveOrCreateAccount({ issuer: 'issuer', subject: 'first' });
  const a = await registry().bindDevice(firstOwner.accountId, deviceA);
  await registry().removeDevice(firstOwner.accountId, deviceA, 'rotate owner');
  const again = await registry().bindDevice(firstOwner.accountId, deviceA);
  assert.ok(again.authorityGeneration > a.authorityGeneration);
  await registry().eraseAccount(firstOwner.accountId);
  const nextOwner = await registry().resolveOrCreateAccount({ issuer: 'issuer', subject: 'new' });
  const b = await registry().bindDevice(nextOwner.accountId, deviceB);
  assert.ok(b.authorityGeneration > again.authorityGeneration);
});
