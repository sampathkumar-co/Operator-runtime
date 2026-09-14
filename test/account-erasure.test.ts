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
  assert.deepEqual(await deliveries.cursor(peer.deviceId), { lastAckedSeq: 1, highestEnqueuedSeq: 1 });
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
  assert.deepEqual(await deliveries.cursor(peer.deviceId), { lastAckedSeq: 2, highestEnqueuedSeq: 2 });
  assert.equal(await results.get(peer.deviceId, second.seq), null);
  assert.equal((await sessions.listIssued(20)).some((record) => record.subjectDeviceId === peer.deviceId), false);
  await assert.rejects(fs.access(bobRoutingDir));

  const persisted = await fs.readFile(path.join(state, 'account-devices.json'), 'utf8');
  const registryState = JSON.parse(persisted) as any;
  assert.equal(registryState.accounts.some((entry: any) => entry.accountId === bob.accountId), false);
  assert.equal(registryState.memberships.some((entry: any) => entry.accountId === bob.accountId), false);
  assert.equal(registryState.erasures.some((entry: any) => entry.accountId === bob.accountId && entry.phase === 'COMPLETE'), true);
  assert.equal(persisted.includes('erase-account'), false);
});
test('account erasure refuses a symlinked accounts parent and preserves external data', async (t) => {
  const state = await temp(t, 'operator-erasure-link-state-');
  const outside = await temp(t, 'operator-erasure-link-outside-');
  const devices = new DeviceRegistryStore(state);
  const accounts = new AccountDeviceRegistry(state, devices);
  const principal = { issuer: 'issuer', subject: 'symlink-test' };
  const account = await accounts.resolveOrCreateAccount(principal);
  const externalAccount = path.join(outside, account.accountId);
  await fs.mkdir(externalAccount, { recursive: true });
  const marker = path.join(externalAccount, 'keep.txt');
  await fs.writeFile(marker, 'preserve');
  const accountsLink = path.join(state, 'accounts');
  try {
    await fs.symlink(outside, accountsLink, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('Windows host does not grant junction/symlink creation.');
      return;
    }
    throw error;
  }
  t.after(() => fs.unlink(accountsLink).catch(() => undefined));
  await assert.rejects(
    accounts.eraseAccount(account.accountId),
    (error: any) => error?.code === 'ACCOUNT_ERASURE_PATH_INVALID'
  );
  assert.equal(await fs.readFile(marker, 'utf8'), 'preserve');
  assert.notEqual(await accounts.getAccount(principal), null);
});


test('account erasure resumes safely after failure injected after every durable phase', async (t) => {
  const phases = [
    'REQUESTED', 'AUTHORITY_REVOKED', 'LIVE_CONNECTIONS_CLOSED', 'ROUTING_DISABLED',
    'DELIVERY_SESSION_RESULT_PURGE', 'ACCOUNT_STORAGE_PURGE', 'REGISTRY_REMOVED', 'COMPLETE'
  ] as const;

  for (const failPhase of phases) {
    await t.test(`recovers after ${failPhase}`, async (st) => {
      const state = await temp(st, `operator-erasure-${failPhase.toLowerCase()}-`);
      const peerState = await temp(st, `operator-erasure-peer-${failPhase.toLowerCase()}-`);
      const identity = new DeviceIdentityStore(state, { platform: 'linux' });
      const peerIdentity = new DeviceIdentityStore(peerState, { platform: 'linux' });
      const authority = await identity.loadOrCreate('Relay');
      const peer = await peerIdentity.loadOrCreate('Device');
      const devices = new DeviceRegistryStore(state);
      const challenge = await devices.issuePairingChallenge(authority, { expectedPeerDeviceId: peer.deviceId, ttlMs: 60_000 });
      await devices.completePairing(await answerPairingChallenge(challenge, peerIdentity));
      const sessions = new DeviceSessionTokenStore(state, identity, devices);
      const deliveries = new RelayDeliveryStore(state);
      const results = new RelayResultStore(state);
      let liveClosed = false;
      let injected = false;
      const makeRegistry = (inject: boolean) => new AccountDeviceRegistry(state, devices, {
        onErasurePhase: async (phase, accountId, deviceIds) => {
          if (phase === 'LIVE_CONNECTIONS_CLOSED') liveClosed = true;
          if (phase === 'ROUTING_DISABLED') {
            const routing = new DeviceRoutingStore(path.join(state, 'accounts', accountId), devices);
            for (const deviceId of deviceIds) await routing.unbindDevice(deviceId);
          }
          if (phase === 'DELIVERY_SESSION_RESULT_PURGE') {
            for (const deviceId of deviceIds) {
              await deliveries.purgeDevice(deviceId);
              await results.purgeDevice(deviceId);
              await sessions.purgeForDevice(deviceId);
            }
          }
        },
        afterErasurePhase: async (phase) => {
          if (inject && !injected && phase === failPhase) {
            injected = true;
            throw new Error(`SIMULATED_CRASH:${phase}`);
          }
        }
      });

      const principal = { issuer: 'issuer', subject: `phase-${failPhase}` };
      const accounts = makeRegistry(true);
      const account = await accounts.resolveOrCreateAccount(principal);
      await accounts.bindDevice(account.accountId, peer.deviceId);
      const routingDir = path.join(state, 'accounts', account.accountId);
      const routing = new DeviceRoutingStore(routingDir, devices);
      await routing.bindProject('project-phase', peer.deviceId);
      const delivery = await deliveries.enqueue(peer.deviceId, 'action', { secret: `payload-${failPhase}` });
      await results.put(peer.deviceId, delivery.seq, delivery.id, { secret: `result-${failPhase}` });
      await sessions.issue({ subjectDeviceId: peer.deviceId, audience: 'operator-relay', scopes: ['relay:connect'], ttlMs: 60_000 });

      await assert.rejects(
        accounts.eraseAccount(account.accountId),
        (error: any) => error instanceof Error && error.message === `SIMULATED_CRASH:${failPhase}`
      );
      assert.equal(injected, true);
      assert.equal(await accounts.ownsDevice(account.accountId, peer.deviceId), false);

      const recovery = makeRegistry(false);
      const recovered = await recovery.recoverErasures();
      assert.equal(recovered, failPhase === 'COMPLETE' ? 0 : 1);
      assert.equal(await recovery.getAccount(principal), null);
      assert.equal(await recovery.ownsDevice(account.accountId, peer.deviceId), false);
      assert.equal(liveClosed, true);
          assert.deepEqual(await deliveries.cursor(peer.deviceId), { lastAckedSeq: delivery.seq, highestEnqueuedSeq: delivery.seq });
      assert.equal(await results.get(peer.deviceId, delivery.seq), null);
      assert.equal((await sessions.listIssued(20)).some((record) => record.subjectDeviceId === peer.deviceId), false);
      await assert.rejects(fs.access(routingDir));

      const persisted = JSON.parse(await fs.readFile(path.join(state, 'account-devices.json'), 'utf8')) as any;
      assert.equal(persisted.accounts.some((entry: any) => entry.accountId === account.accountId), false);
      assert.equal(persisted.memberships.some((entry: any) => entry.accountId === account.accountId), false);
      const tombstone = persisted.erasures.find((entry: any) => entry.accountId === account.accountId);
      assert.equal(tombstone.phase, 'COMPLETE');
      assert.equal(typeof tombstone.completedAt, 'string');
      assert.equal(JSON.stringify(tombstone).includes(`payload-${failPhase}`), false);
      assert.equal(JSON.stringify(tombstone).includes(`result-${failPhase}`), false);
    });
  }
});
