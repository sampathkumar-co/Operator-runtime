import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { DeviceRegistryStore, answerPairingChallenge } from '../../../src/core/device-registry.ts';
import { RelayDeliveryStore } from '../../../src/core/relay-delivery-store.ts';
import { DeviceSessionTokenStore } from '../../../src/core/session-token.ts';
import { RelayResultService } from '../src/result-service.ts';

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function pairDevice(authorityIdentity: DeviceIdentityStore, devices: DeviceRegistryStore, deviceIdentity: DeviceIdentityStore) {
  const authority = await authorityIdentity.loadOrCreate('Relay Authority');
  const device = await deviceIdentity.loadOrCreate('Paired Device');
  const challenge = await devices.issuePairingChallenge(authority, { expectedPeerDeviceId: device.deviceId, ttlMs: 60_000 });
  await devices.completePairing(await answerPairingChallenge(challenge, deviceIdentity));
  return device;
}

test('relay result service accepts only scoped results matching the first pending delivery and stores duplicates idempotently', async (t) => {
  const authorityState = await tempDir(t, 'operator-result-service-authority-');
  const deviceState = await tempDir(t, 'operator-result-service-device-');
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  const devices = new DeviceRegistryStore(authorityState);
  const device = await pairDevice(authorityIdentity, devices, deviceIdentity);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices);
  const deliveries = new RelayDeliveryStore(authorityState);
  const first = await deliveries.enqueue(device.deviceId, 'action', { action: { id: 'a1' } });
  await deliveries.enqueue(device.deviceId, 'action', { action: { id: 'a2' } });

  const service = new RelayResultService({ stateDir: authorityState, identity: authorityIdentity, devices, sessions, deliveries });
  t.after(() => service.close());
  const { port } = await service.listen('127.0.0.1', 0);
  const url = `http://127.0.0.1:${port}/v1/device-result`;

  const limited = (await sessions.issue({
    subjectDeviceId: device.deviceId,
    audience: 'operator-relay',
    scopes: ['relay:connect'],
    ttlMs: 60_000
  })).token;
  const denied = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${limited}` },
    body: JSON.stringify({ seq: first.seq, deliveryId: first.id, result: { ok: true } })
  });
  assert.equal(denied.status, 401);

  const token = (await sessions.issue({
    subjectDeviceId: device.deviceId,
    audience: 'operator-relay',
    scopes: ['relay:connect', 'relay:result'],
    ttlMs: 60_000
  })).token;

  const mismatch = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ seq: first.seq + 1, deliveryId: first.id, result: { ok: true } })
  });
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json() as any).error.code, 'RELAY_RESULT_DELIVERY_MISMATCH');

  const accepted = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ seq: first.seq, deliveryId: first.id, result: { ok: true, output: { value: 7 } } })
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json() as any).accepted.duplicate, false);
  assert.deepEqual((await service.getResult(device.deviceId, first.seq))?.result, { ok: true, output: { value: 7 } });

  const duplicate = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ seq: first.seq, deliveryId: first.id, result: { ok: true, output: { value: 7 } } })
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json() as any).accepted.duplicate, true);

  const conflict = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ seq: first.seq, deliveryId: first.id, result: { ok: false, error: { code: 'FORGED' } } })
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as any).error.code, 'RELAY_RESULT_CONFLICT');
});
