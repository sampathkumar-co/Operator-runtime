import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeviceEnrollmentStore } from '../src/core/device-enrollment.ts';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';

async function temp(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('separate enrollment stores retain concurrent pairings and reject cross-account claim races', async (t) => {
  const state = await temp(t, 'mecord-enrollment-concurrency-');
  const stores = Array.from({ length: 8 }, () => new DeviceEnrollmentStore(state));
  const peers = await Promise.all(Array.from({ length: 12 }, async (_, index) =>
    new DeviceIdentityStore(await temp(t, 'mecord-enrollment-peer-'), { platform: 'linux' }).loadOrCreate('Test peer ' + index)
  ));
  const created = await Promise.all(peers.map((peer, index) => stores[index % stores.length]!.create(peer)));
  assert.equal(new Set(created.map((item) => item.enrollmentId)).size, 12);
  const reloaded = new DeviceEnrollmentStore(state);
  for (const record of created) {
    const value = await reloaded.poll(record.enrollmentId, record.pollToken);
    assert.equal(value.status, 'pending');
    assert.equal(value.deviceId, record.deviceId);
  }

  const a = crypto.randomUUID(), b = crypto.randomUUID();
  const result = await Promise.allSettled([
    stores[0]!.reserve(created[0]!.userCode, a),
    stores[1]!.reserve(created[0]!.userCode, b)
  ]);
  const successes = result.filter((item): item is PromiseFulfilledResult<any> => item.status === 'fulfilled');
  const failures = result.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.reason?.code, 'DEVICE_ENROLLMENT_ACCOUNT_CONFLICT');
  const final = await reloaded.poll(created[0]!.enrollmentId, created[0]!.pollToken);
  assert.equal(final.status, 'reserved');
  assert.equal(final.accountId, successes[0]!.value.accountId);
  for (const item of created.slice(1)) {
    assert.equal((await reloaded.poll(item.enrollmentId, item.pollToken)).status, 'pending');
  }
});
