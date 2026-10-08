import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RelayOwnershipFenceStore } from '../src/core/production-trust-platform.ts';
import { RelayReservationReconciliationStore } from '../src/core/relay-reservation-reconciliation.ts';
import { DeviceResetStore } from '../src/core/device-reset.ts';

async function tmp(t: test.TestContext): Promise<string> {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'operator-ownership-audit-'));
  t.after(()=>fs.rm(dir,{force:true,recursive:true}));
  return dir;
}
test('independent relay owners cannot both acquire a live resource fence', async t => {
  const dir=await tmp(t);
  const stores=Array.from({length:8},()=>new RelayOwnershipFenceStore(dir));
  const outcomes=await Promise.allSettled(stores.map((s,i)=>s.acquire({
    resourceKey:'device:shared',ownerInstanceId:'relay:'+i,leaseMs:30000
  })));
  const successes=outcomes.filter(x=>x.status==='fulfilled');
  assert.equal(successes.length,1,'only one owner may successfully acquire the same resource');
  const winner=successes[0] as PromiseFulfilledResult<Awaited<ReturnType<RelayOwnershipFenceStore['acquire']>>>;
  assert.equal((await new RelayOwnershipFenceStore(dir).assertCurrent({
    resourceKey:winner.value.resourceKey,ownerInstanceId:winner.value.ownerInstanceId,
    generation:winner.value.generation,token:winner.value.token
  })).token,winner.value.token);
});
test('independent relay reconciliation writers retain each unresolved reservation', async t => {
  const dir=await tmp(t);
  await Promise.all(Array.from({length:8},(_,i)=>new RelayReservationReconciliationStore(dir).record({
    accountId:crypto.randomUUID(),operationId:crypto.randomUUID(),
    workloadKey:'mission:shared',reservationId:crypto.randomUUID(),
    sessionId:crypto.randomUUID(),action:'release',errorCode:'RELEASE_FAILED'
  })));
  assert.equal((await new RelayReservationReconciliationStore(dir).pending()).length,8);
});
test('independent device reset stores preserve every authority-bound request', async t => {
  const dir=await tmp(t);
  const accountId=crypto.randomUUID(),deviceId=crypto.randomUUID();
  const ids=Array.from({length:8},()=>crypto.randomUUID());
  await Promise.all(ids.map(sessionJti=>new DeviceResetStore(dir).begin({
    sessionJti,deviceId,accountId,authorityGeneration:5
  })));
  const checker=new DeviceResetStore(dir);
  const found=await Promise.all(ids.map(id=>checker.get(id)));
  assert.equal(found.filter(Boolean).length,8);
});

test('cross-process relay fencing admits exactly one independent process owner', async t => {
  const dir=await tmp(t);
  const { execFile }=await import('node:child_process');
  const { promisify }=await import('node:util');
  const { pathToFileURL }=await import('node:url');
  const exec=promisify(execFile);
  const uri=pathToFileURL(path.resolve('src/core/production-trust-platform.ts')).href;
  const script=`import {RelayOwnershipFenceStore} from ${JSON.stringify(uri)};
const s=new RelayOwnershipFenceStore(process.argv[1]);
await s.acquire({resourceKey:'device:independent',ownerInstanceId:process.argv[2],leaseMs:30000});`;
  const outcomes=await Promise.allSettled(Array.from({length:4},(_,i)=>exec(
    process.execPath,['--experimental-strip-types','--input-type=module','-e',script,dir,'owner:'+i],
    {cwd:process.cwd(),timeout:30000,windowsHide:true}
  )));
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
});
test('concurrent idempotent reconciliation retries increment one durable record', async t => {
  const dir=await tmp(t);
  const input={
    accountId:crypto.randomUUID(),operationId:crypto.randomUUID(),
    workloadKey:'mission:shared',reservationId:crypto.randomUUID(),
    sessionId:crypto.randomUUID(),action:'release' as const,errorCode:'RELEASE_FAILED'
  };
  const results=await Promise.all(Array.from({length:8},()=>new RelayReservationReconciliationStore(dir).record(input)));
  assert.equal(new Set(results.map(r=>r.id)).size,1);
  const pending=await new RelayReservationReconciliationStore(dir).pending();
  assert.equal(pending.length,1);
  assert.equal(pending[0]?.attempts,8);
});
test('concurrent conflicting device reset authority fails closed without rebinding', async t => {
  const dir=await tmp(t);
  const sessionJti=crypto.randomUUID(),accountId=crypto.randomUUID(),deviceId=crypto.randomUUID();
  const stores=Array.from({length:8},()=>new DeviceResetStore(dir));
  const results=await Promise.allSettled(stores.map((store,i)=>store.begin({
    sessionJti,accountId,deviceId,authorityGeneration:i+1
  })));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected').length,7);
  const stored=await new DeviceResetStore(dir).get(sessionJti);
  assert.ok(stored);
  assert.ok(stored.authorityGeneration>=1 && stored.authorityGeneration<=8);
});
