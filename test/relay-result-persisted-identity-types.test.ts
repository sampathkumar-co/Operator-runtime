import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RelayResultStore } from '../src/core/relay-result-store.ts';

for (const field of ['seq','deliveryId','resultSha256','idempotencyKey','recordedAt','replayAccountId','replayDeviceId'] as const) {
  test('persisted relay result rejects type-coerced '+field, async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-relay-result-typed-'));
    t.after(() => fs.rm(dir,{recursive:true,force:true}));
    const deviceId = crypto.randomUUID();
    const deliveryId = crypto.randomUUID();
    const key = 'a'.repeat(64);
    const authority = {accountId:crypto.randomUUID(),deviceId,generation:7};
    const store = new RelayResultStore(dir);
    await store.put(deviceId,7,deliveryId,{ok:true,output:{value:'verified'}},key,authority);
    const file = path.join(dir,'relay-results.json');
    const state = JSON.parse(await fs.readFile(file,'utf8'));
    const entry = state.streams[0].results[0];
    if (field === 'replayAccountId') entry.replayAuthority.accountId = [entry.replayAuthority.accountId];
    else if (field === 'replayDeviceId') entry.replayAuthority.deviceId = [entry.replayAuthority.deviceId];
    else entry[field] = field === 'seq' ? '7' : [entry[field]];
    const malformed=JSON.stringify(state);
    await fs.writeFile(file,malformed);
    await assert.rejects(new RelayResultStore(dir).get(deviceId,7),
      (e:any) => ['RELAY_RESULT_SEQUENCE_INVALID','RELAY_RESULT_ID_INVALID','RELAY_RESULT_STATE_CORRUPT','RELAY_RESULT_AUTHORITY_INVALID','RELAY_IDEMPOTENCY_INVALID'].includes(e?.code));
    assert.equal(await fs.readFile(file,'utf8'),malformed,'invalid replay state must not be rewritten');
  });
}

test('relay result API refuses coerced caller delivery and replay identity', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-relay-result-input-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const deviceId=crypto.randomUUID(),deliveryId=crypto.randomUUID(),accountId=crypto.randomUUID(),key='f'.repeat(64);
  const store=new RelayResultStore(dir);
  for(const [seq,id,authority,idem] of [
    ['1',deliveryId,undefined,undefined],
    [1,[deliveryId],undefined,undefined],
    [1,deliveryId,{accountId:[accountId],deviceId,generation:1},key],
    [1,deliveryId,{accountId,deviceId:[deviceId],generation:1},key],
    [1,deliveryId,{accountId,deviceId,generation:1},[key]],
  ] as const) {
    await assert.rejects(store.put(deviceId,seq as any,id as any,{ok:true},idem as any,authority as any));
  }
});
