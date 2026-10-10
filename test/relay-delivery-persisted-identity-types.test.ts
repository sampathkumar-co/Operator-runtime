import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RelayDeliveryStore } from '../src/core/relay-delivery-store.ts';

for (const field of ['streamDeviceId','baseSeq','nextSeq','lastAckedSeq','deliverySeq','deliveryId','kind','createdAt','idempotencyKey','authorityAccountId','authorityDeviceId'] as const) {
  test('persisted relay delivery rejects coerced '+field, async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-relay-queue-typed-'));
    t.after(() => fs.rm(dir,{recursive:true,force:true}));
    const deviceId=crypto.randomUUID(),accountId=crypto.randomUUID(),key='a'.repeat(64);
    const store = new RelayDeliveryStore(dir);
    const delivery = await store.enqueue(deviceId,'action',{action:{capability:'file.read'}},{accountId,deviceId,generation:1},key,['file.read']);
    const file=path.join(dir,'relay-deliveries.json');
    const state=JSON.parse(await fs.readFile(file,'utf8'));
    const stream=state.streams[0],entry=stream.deliveries[0];
    switch (field) {
      case 'streamDeviceId': stream.deviceId=[stream.deviceId];break;
      case 'baseSeq': stream.baseSeq='1';break;
      case 'nextSeq': stream.nextSeq='2';break;
      case 'lastAckedSeq': stream.lastAckedSeq='0';break;
      case 'deliverySeq': entry.seq='1';break;
      case 'deliveryId': entry.id=[entry.id];break;
      case 'kind': entry.kind=[entry.kind];break;
      case 'createdAt': entry.createdAt=[entry.createdAt];break;
      case 'idempotencyKey': entry.idempotencyKey=[entry.idempotencyKey];break;
      case 'authorityAccountId': entry.authority.accountId=[entry.authority.accountId];break;
      case 'authorityDeviceId': entry.authority.deviceId=[entry.authority.deviceId];break;
    }
    const malformed=JSON.stringify(state);
    await fs.writeFile(file,malformed);
    await assert.rejects(new RelayDeliveryStore(dir).pending(deviceId),
      (e:any) => ['RELAY_QUEUE_CORRUPT','RELAY_SEQUENCE_INVALID','RELAY_ID_INVALID','RELAY_KIND_INVALID','RELAY_IDEMPOTENCY_INVALID'].includes(e?.code));
    assert.equal(await fs.readFile(file,'utf8'),malformed,'must not rewrite corrupted authority/replay state');
  });
}

test('relay delivery API rejects coerced caller IDs and sequence controls', async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-queue-input-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const deviceId=crypto.randomUUID(),accountId=crypto.randomUUID();
  const store=new RelayDeliveryStore(dir);
  for(const authority of [
    {accountId:[accountId],deviceId,generation:1},
    {accountId,deviceId:[deviceId],generation:1}
  ]) {
    await assert.rejects(store.enqueue(deviceId,'action',{ok:true},authority as any));
  }
  await assert.rejects(store.enqueue([deviceId] as any,'action',{ok:true}));
  await assert.rejects(store.enqueue(deviceId,['action'] as any,{ok:true}));
  const first=await store.enqueue(deviceId,'action',{ok:true});
  await assert.rejects(store.acknowledge(deviceId,String(first.seq) as any,first.id));
  await assert.rejects(store.acknowledge(deviceId,first.seq,[first.id] as any));
});
