import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccountDeviceRegistry } from '../src/core/account-device-registry.ts';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { DeviceRegistryStore, answerPairingChallenge } from '../src/core/device-registry.ts';
import { DeviceRoutingStore } from '../src/core/device-routing.ts';
import { RelayDeliveryStore } from '../src/core/relay-delivery-store.ts';
import { RelayResultStore } from '../src/core/relay-result-store.ts';
import { DeviceSessionTokenStore } from '../src/core/session-token.ts';

async function temp(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('device release and account erasure cascade hosted account data before rebinding', async (t) => {
  const state = await temp(t, 'operator-erasure-state-');
  const peerState = await temp(t, 'operator-erasure-peer-');
  const identity = new DeviceIdentityStore(state, { platform: 'linux' });
  const peerIdentity = new DeviceIdentityStore(peerState, { platform: 'linux' });
  const authority = await identity.loadOrCreate('Relay');
  const peer = await peerIdentity.loadOrCreate('Device');
  const devices = new DeviceRegistryStore(state);
  const challenge = await devices.issuePairingChallenge(authority, { expectedPeerDeviceId: peer.deviceId, ttlMs: 60_000 });
  await devices.completePairing(await answerPairingChallenge(challenge, peerIdentity));  const sessions = new DeviceSessionTokenStore(state, identity, devices);
  const deliveries = new RelayDeliveryStore(state);
  const results = new RelayResultStore(state);
  const accounts = new AccountDeviceRegistry(state, devices, {
    onReleaseDevice: async (deviceId, accountId) => {
      await deliveries.purgeDevice(deviceId);
      await results.purgeDevice(deviceId);
      await sessions.purgeForDevice(deviceId);
      await new DeviceRoutingStore(path.join(state, 'accounts', accountId), devices).unbindDevice(deviceId);
    }
  });

  const alicePrincipal = { issuer: 'issuer', subject: 'alice' };
  const bobPrincipal = { issuer: 'issuer', subject: 'bob' };
  const alice = await accounts.resolveOrCreateAccount(alicePrincipal);
  const bob = await accounts.resolveOrCreateAccount(bobPrincipal);
  await accounts.bindDevice(alice.accountId, peer.deviceId);
  const aliceRouting = new DeviceRoutingStore(path.join(state, 'accounts', alice.accountId), devices);
  await aliceRouting.bindProject('project-a', peer.deviceId);
  const delivery = await deliveries.enqueue(peer.deviceId, 'action', { secretPayload: 'must-be-erased' });
  await results.put(peer.deviceId, delivery.seq, delivery.id, { secretResult: 'must-be-erased' });
  await sessions.issue({ subjectDeviceId: peer.deviceId, audience: 'operator-relay', scopes: ['relay:connect'], ttlMs: 60_000 });

  await accounts.removeDevice(alice.accountId, peer.deviceId, 'transfer');
  assert.deepEqual(await deliveries.cursor(peer.deviceId), { lastAckedSeq: 0, highestEnqueuedSeq: 0 });
  assert.equal(await results.get(peer.deviceId, delivery.seq), null);  assert.equal((await sessions.listIssued(20)).some((record) => record.subjectDeviceId === peer.deviceId), false);
  assert.equal((await aliceRouting.listBindings()).length, 0);

  await accounts.bindDevice(bob.accountId, peer.deviceId);
  assert.equal(await accounts.ownsDevice(bob.accountId, peer.deviceId), true);

  const bobRoutingDir = path.join(state, 'accounts', bob.accountId);
  const bobRouting = new DeviceRoutingStore(bobRoutingDir, devices);
  await bobRouting.bindProject('project-b', peer.deviceId);
  const second = await deliveries.enqueue(peer.deviceId, 'action', { privateData: 'erase-account' });
  await results.put(peer.deviceId, second.seq, second.id, { privateData: 'erase-account' });
  await sessions.issue({ subjectDeviceId: peer.deviceId, audience: 'operator-relay', scopes: ['relay:connect'], ttlMs: 60_000 });

  const erased = await accounts.erasePrincipal(bobPrincipal);
  assert.equal(erased.erased, true);
  assert.deepEqual(erased.releasedDeviceIds, [peer.deviceId]);
  assert.equal(await accounts.getAccount(bobPrincipal), null);
  assert.equal(await accounts.ownsDevice(bob.accountId, peer.deviceId), false);
  assert.deepEqual(await deliveries.cursor(peer.deviceId), { lastAckedSeq: 0, highestEnqueuedSeq: 0 });
  assert.equal(await results.get(peer.deviceId, second.seq), null);
  assert.equal((await sessions.listIssued(20)).some((record) => record.subjectDeviceId === peer.deviceId), false);
  await assert.rejects(fs.access(bobRoutingDir));

  const persisted = await fs.readFile(path.join(state, 'account-devices.json'), 'utf8');
  assert.equal(persisted.includes(bob.accountId), false);
  assert.equal(persisted.includes('erase-account'), false);
});