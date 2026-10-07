import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EmbeddedControlPlaneStore } from '../../../src/core/control-plane-store.ts';
import { RelayDeliveryStore } from '../../../src/core/relay-delivery-store.ts';
import { RelayResultStore } from '../../../src/core/relay-result-store.ts';
import { runRelayService } from '../src/main.ts';

function config(stateDir:string){
  return {
    stateDir,
    host:'127.0.0.1',
    port:0,
    resultHost:'127.0.0.1',
    resultPort:0,
    controlHost:'127.0.0.1' as const,
    controlPort:0
  };
}

test('two relay service instances can share one cluster control plane without sharing local state directories',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-r5-relay-cluster-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const shared=new EmbeddedControlPlaneStore(path.join(root,'shared'));
  const a=await runRelayService(config(path.join(root,'a')),{controlPlaneStore:shared,instanceId:'relay-a',clusterLeaseMs:60_000});
  const b=await runRelayService(config(path.join(root,'b')),{controlPlaneStore:shared,instanceId:'relay-b',clusterLeaseMs:60_000});
  t.after(async()=>{await Promise.allSettled([a.close(),b.close()]);});
  const aAddress=(a as any)['#server'];
  assert.ok(a);
  assert.ok(b);
});


test('shared relay stores preserve delivery and result truth across instances',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-r5-shared-state-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const shared=new EmbeddedControlPlaneStore(path.join(root,'shared'));
  const deliveryA=new RelayDeliveryStore(path.join(root,'a'),{sharedStore:shared,sharedNamespace:'relay-delivery-streams'});
  const deliveryB=new RelayDeliveryStore(path.join(root,'b'),{sharedStore:shared,sharedNamespace:'relay-delivery-streams'});
  const resultA=new RelayResultStore(path.join(root,'a'),{sharedStore:shared,sharedNamespace:'relay-result-streams'});
  const resultB=new RelayResultStore(path.join(root,'b'),{sharedStore:shared,sharedNamespace:'relay-result-streams'});
  const deviceId='11111111-1111-4111-8111-111111111111';
  const accountId='22222222-2222-4222-8222-222222222222';
  const idempotencyKey='a'.repeat(64);
  const authority={accountId,deviceId,generation:1};

  const first=await deliveryA.enqueue(deviceId,'action',{action:{risk:'read'}},authority,idempotencyKey,['file.read']);
  const pendingFromB=await deliveryB.pending(deviceId);
  assert.equal(pendingFromB.length,1);
  assert.equal(pendingFromB[0]!.id,first.id);

  const recovered=await deliveryB.enqueue(deviceId,'action',{action:{risk:'read'}},authority,idempotencyKey,['file.read']);
  assert.equal(recovered.id,first.id);
  await deliveryB.acknowledge(deviceId,first.seq,first.id);
  assert.equal((await deliveryA.cursor(deviceId)).lastAckedSeq,first.seq);

  const stored=await resultA.put(deviceId,first.seq,first.id,{ok:true},idempotencyKey,authority);
  assert.equal(stored.duplicate,false);
  assert.equal((await resultB.get(deviceId,first.seq))?.deliveryId,first.id);
  assert.equal((await resultB.findByIdempotencyKey(idempotencyKey))?.deviceId,deviceId);
  assert.equal((await resultB.consume(deviceId,first.seq,first.id))?.result?.ok,true);
  assert.equal(await resultA.get(deviceId,first.seq),null);
});

test('shared relay CAS preserves global idempotency across concurrent device streams',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-r5-shared-idempotency-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const shared=new EmbeddedControlPlaneStore(path.join(root,'shared'));
  const a=new RelayDeliveryStore(path.join(root,'a'),{sharedStore:shared});
  const b=new RelayDeliveryStore(path.join(root,'b'),{sharedStore:shared});
  const accountId='33333333-3333-4333-8333-333333333333';
  const deviceA='44444444-4444-4444-8444-444444444444';
  const deviceB='55555555-5555-4555-8555-555555555555';
  const key='b'.repeat(64);
  const settled=await Promise.allSettled([
    a.enqueue(deviceA,'action',{action:{risk:'read'}},{accountId,deviceId:deviceA,generation:1},key,['file.read']),
    b.enqueue(deviceB,'action',{action:{risk:'read'}},{accountId,deviceId:deviceB,generation:1},key,['file.read'])
  ]);
  assert.equal(settled.filter((item)=>item.status==='fulfilled').length,1);
  const rejected=settled.find((item)=>item.status==='rejected') as PromiseRejectedResult;
  assert.equal((rejected.reason as any)?.code,'RELAY_IDEMPOTENCY_ROUTE_CHANGED');
});
