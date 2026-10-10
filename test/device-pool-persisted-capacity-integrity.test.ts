import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DevicePoolScheduler } from '../src/core/device-pool.ts';
import type { DeviceRegistryStore } from '../src/core/device-registry.ts';
import type { DeviceRoutingStore } from '../src/core/device-routing.ts';

test('malformed persisted reservation capacity cannot silently change allocated slots or memory bounds', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-device-capacity-integrity-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const file = path.join(dir,'device-pool.json');
  const reservation = {
    id:crypto.randomUUID(), workloadKey:'batch:one', deviceId:crypto.randomUUID(),
    sessionId:crypto.randomUUID(), requiredCapabilities:['app.operate'], requiredTags:[],
    minMemoryMb:256, slots:4, requireGpu:false, acquiredAt:'2026-10-09T00:00:00.000Z',
    heartbeatAt:'2026-10-09T00:00:00.000Z', expiresAt:'2027-10-12T00:00:00.000Z',
    state:'ACTIVE'
  };
  const original = {version:1,reservations:[reservation]};
  const scheduler = new DevicePoolScheduler(dir,{} as DeviceRegistryStore,{} as DeviceRoutingStore);
  const invalid = [
    ['slots','4'],['slots',true],['slots',[4]],['minMemoryMb',null],
    ['minMemoryMb','256'],['minMemoryMb',false]
  ] as const;
  for (const [field,value] of invalid) {
    const poisoned = structuredClone(original) as any;
    poisoned.reservations[0][field] = value;
    await fs.writeFile(file,JSON.stringify(poisoned));
    await assert.rejects(() => scheduler.list({activeOnly:true}),
      (error:any)=>error?.code==='DEVICE_POOL_STATE_CORRUPT',
      field + ' must retain its persisted JSON number type');
    assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),poisoned);
  }
  await fs.writeFile(file,JSON.stringify(original));
  const after = await scheduler.list({activeOnly:true});
  assert.equal(after.length,1);
  assert.equal(after[0].slots,4);
  assert.equal(after[0].minMemoryMb,256);
});
