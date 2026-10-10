import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccountDeviceRegistry } from '../src/core/account-device-registry.ts';
import type { DeviceRegistryStore } from '../src/core/device-registry.ts';

test('corrupt persisted authority high-water cannot reset device generation after erasure', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-authority-floor-integrity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const deviceId = crypto.randomUUID();
  const devices = {listDevices:async()=>[{deviceId,status:'active'}]} as unknown as DeviceRegistryStore;
  const registry = () => new AccountDeviceRegistry(dir, devices);
  const account = await registry().resolveOrCreateAccount({issuer:'issuer',subject:'replacement'});
  const file = path.join(dir,'account-devices.json');
  const state = JSON.parse(await fs.readFile(file,'utf8'));
  state.authorityGenerationFloor = 16;
  await fs.writeFile(file,JSON.stringify(state));
  for (const corrupt of [null,'16',false,{},[]]) {
    const bad = structuredClone(state);
    bad.authorityGenerationFloor = corrupt;
    await fs.writeFile(file,JSON.stringify(bad));
    await assert.rejects(
      registry().bindDevice(account.accountId,deviceId),
      (error:any)=>error?.code==='ACCOUNT_STATE_CORRUPT',
      'malformed floor must never be coerced to a reusable generation'
    );
    assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),bad,
      'invalid registry must remain untouched');
  }
  await fs.writeFile(file,JSON.stringify(state));
  const membership = await registry().bindDevice(account.accountId,deviceId);
  assert.equal(membership.authorityGeneration,17);
});
