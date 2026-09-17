import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccountDeviceRegistry, MAX_ACTIVE_DEVICES_PER_ACCOUNT, MAX_KNOWN_DEVICES_PER_ACCOUNT } from '../src/core/account-device-registry.ts';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { DeviceRegistryStore, answerPairingChallenge } from '../src/core/device-registry.ts';

async function temp(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function pairedFixture(t: test.TestContext) {
  const authorityDir = await temp(t, 'operator-account-authority-');
  const peerDir = await temp(t, 'operator-account-peer-');
  const stateDir = await temp(t, 'operator-account-state-');
  const authority = new DeviceIdentityStore(authorityDir, { platform: 'linux' });
  const peerStore = new DeviceIdentityStore(peerDir, { platform: 'linux' });
  const authorityPublic = await authority.loadOrCreate('Relay Authority');
  const peer = await peerStore.loadOrCreate('Device');
  const devices = new DeviceRegistryStore(stateDir);
  const challenge = await devices.issuePairingChallenge(authorityPublic, { expectedPeerDeviceId: peer.deviceId, ttlMs: 60_000 });
  await devices.completePairing(await answerPairingChallenge(challenge, peerStore));
  const accounts = new AccountDeviceRegistry(stateDir, devices);
  return { stateDir, devices, accounts, peer };
}

test('account registry hashes upstream auth principal and persists no raw subject or issuer', async (t) => {
  const { stateDir, devices, accounts } = await pairedFixture(t);
  const principal = { issuer: 'https://login.example.invalid/tenant', subject: 'user-sensitive-subject-12345' };
  const first = await accounts.resolveOrCreateAccount(principal);
  const reloaded = new AccountDeviceRegistry(stateDir, devices);
  const second = await reloaded.getAccount(principal);
  assert.equal(second?.accountId, first.accountId);
  assert.match(first.accountId, /^[0-9a-f-]{36}$/i);
  assert.equal(first.principalHash.length, 43);
  const persisted = await fs.readFile(path.join(stateDir, 'account-devices.json'), 'utf8');
  assert.equal(persisted.includes(principal.subject), false);
  assert.equal(persisted.includes(principal.issuer), false);
});

test('paired device can be bound to one active account and cannot silently cross accounts', async (t) => {
  const { accounts, peer } = await pairedFixture(t);
  const a = await accounts.resolveOrCreateAccount({ issuer: 'issuer', subject: 'alice' });
  const b = await accounts.resolveOrCreateAccount({ issuer: 'issuer', subject: 'bob' });
  const membership = await accounts.bindDevice(a.accountId, peer.deviceId);
  assert.equal(membership.status, 'active');
  assert.equal(await accounts.ownsDevice(a.accountId, peer.deviceId), true);
  await assert.rejects(accounts.bindDevice(b.accountId, peer.deviceId), (error: any) => error?.code === 'DEVICE_ACCOUNT_CONFLICT');
});

test('explicit device removal permits deliberate rebinding but crypto revocation still blocks ownership', async (t) => {
  const { devices, accounts, peer } = await pairedFixture(t);
  const a = await accounts.resolveOrCreateAccount({ issuer: 'issuer', subject: 'alice' });
  const b = await accounts.resolveOrCreateAccount({ issuer: 'issuer', subject: 'bob' });
  await accounts.bindDevice(a.accountId, peer.deviceId);
  await accounts.removeDevice(a.accountId, peer.deviceId, 'user moved device');
  await accounts.bindDevice(b.accountId, peer.deviceId);
  assert.equal(await accounts.ownsDevice(a.accountId, peer.deviceId), false);
  assert.equal(await accounts.ownsDevice(b.accountId, peer.deviceId), true);

  await devices.revokeDevice(peer.deviceId, 'device lost');
  assert.equal(await accounts.ownsDevice(b.accountId, peer.deviceId), false);
  assert.deepEqual(await accounts.listDevices(b.accountId), []);
});

test('disabled account loses active memberships and cannot bind devices', async (t) => {
  const { accounts, peer } = await pairedFixture(t);
  const account = await accounts.resolveOrCreateAccount({ issuer: 'issuer', subject: 'disabled-user' });
  await accounts.bindDevice(account.accountId, peer.deviceId);
  const disabled = await accounts.disableAccount(account.accountId, 'account closed');
  assert.equal(disabled.status, 'disabled');
  assert.equal(await accounts.ownsDevice(account.accountId, peer.deviceId), false);
  await assert.rejects(accounts.listDevices(account.accountId), (error: any) => error?.code === 'ACCOUNT_DISABLED');
  await assert.rejects(accounts.bindDevice(account.accountId, peer.deviceId), (error: any) => error?.code === 'ACCOUNT_DISABLED');
  await assert.rejects(accounts.resolveOrCreateAccount({ issuer: 'issuer', subject: 'disabled-user' }), (error: any) => error?.code === 'ACCOUNT_DISABLED');
});

test('device authority generation advances across A-B-A ownership cycles', async (t) => {
  const { accounts, peer } = await pairedFixture(t);
  const a = await accounts.resolveOrCreateAccount({ issuer: 'issuer', subject: 'alice-generation' });
  const b = await accounts.resolveOrCreateAccount({ issuer: 'issuer', subject: 'bob-generation' });

  const a1 = await accounts.bindDevice(a.accountId, peer.deviceId);
  assert.equal(a1.authorityGeneration, 1);
  await accounts.removeDevice(a.accountId, peer.deviceId, 'move to b');
  const b2 = await accounts.bindDevice(b.accountId, peer.deviceId);
  assert.equal(b2.authorityGeneration, 2);
  await accounts.removeDevice(b.accountId, peer.deviceId, 'move back to a');
  const a3 = await accounts.bindDevice(a.accountId, peer.deviceId);
  assert.equal(a3.authorityGeneration, 3);
});


test('device release commits authority revocation before cleanup and failed cleanup is recoverable', async (t) => {
  const { stateDir, devices, peer } = await pairedFixture(t);
  let hookSawRevoked = false;
  let failCleanup = true;
  const accounts = new AccountDeviceRegistry(stateDir, devices, { onReleaseDevice: async (deviceId) => {
    hookSawRevoked = (await new AccountDeviceRegistry(stateDir, devices).activeMembershipForDevice(deviceId)) === null;
    if (failCleanup) { failCleanup = false; throw new Error('simulated cleanup crash'); }
  } });
  const owner = await accounts.resolveOrCreateAccount({ issuer: 'issuer', subject: 'release-order-owner' });
  await accounts.bindDevice(owner.accountId, peer.deviceId);
  await assert.rejects(accounts.removeDevice(owner.accountId, peer.deviceId, 'release ordering'), /simulated cleanup crash/);
  assert.equal(hookSawRevoked, true);
  assert.equal(await accounts.activeMembershipForDevice(peer.deviceId), null);
  const persistedBefore = JSON.parse(await fs.readFile(path.join(stateDir, 'account-devices.json'), 'utf8'));
  assert.equal(persistedBefore.memberships.find((m: any) => m.deviceId === peer.deviceId)?.releasePendingReason, 'removed');
  let recovered = 0;
  const reloaded = new AccountDeviceRegistry(stateDir, devices, { onReleaseDevice: async () => { recovered += 1; } });
  assert.equal(await reloaded.recoverReleases(), 1);
  assert.equal(recovered, 1);
  const persistedAfter = JSON.parse(await fs.readFile(path.join(stateDir, 'account-devices.json'), 'utf8'));
  assert.equal('releasePendingReason' in persistedAfter.memberships.find((m: any) => m.deviceId === peer.deviceId), false);
});

test('account erasure cannot discard unfinished device-release cleanup', async (t) => {
  const { stateDir, devices, peer } = await pairedFixture(t);
  let allowCleanup = false;
  let cleanupAttempts = 0;
  const accounts = new AccountDeviceRegistry(stateDir, devices, { onReleaseDevice: async () => {
    cleanupAttempts += 1;
    if (!allowCleanup) throw new Error('cleanup still blocked');
  } });
  const owner = await accounts.resolveOrCreateAccount({ issuer: 'issuer', subject: 'erase-pending-release-owner' });
  await accounts.bindDevice(owner.accountId, peer.deviceId);
  await assert.rejects(accounts.removeDevice(owner.accountId, peer.deviceId, 'prepare pending cleanup'), /cleanup still blocked/);
  await assert.rejects(accounts.eraseAccount(owner.accountId), /cleanup still blocked/);
  const blocked = JSON.parse(await fs.readFile(path.join(stateDir, 'account-devices.json'), 'utf8'));
  assert.equal(blocked.accounts.some((account: any) => account.accountId === owner.accountId), true);
  assert.equal(blocked.memberships.find((membership: any) => membership.deviceId === peer.deviceId)?.releasePendingReason, 'removed');
  assert.equal(cleanupAttempts, 2);
  allowCleanup = true;
  await accounts.eraseAccount(owner.accountId);
  assert.equal(cleanupAttempts, 3);
  const completed = JSON.parse(await fs.readFile(path.join(stateDir, 'account-devices.json'), 'utf8'));
  assert.equal(completed.accounts.some((account: any) => account.accountId === owner.accountId), false);
  assert.equal(completed.memberships.some((membership: any) => membership.accountId === owner.accountId), false);
});

test('authority lease forces durable work to finish before release purge starts', async (t) => {
  const { devices, peer, stateDir } = await pairedFixture(t);
  let purgeStarted = false;
  let durableWorkFinished = false;
  const accounts = new AccountDeviceRegistry(stateDir, devices, { onReleaseDevice: async () => {
    purgeStarted = true;
    assert.equal(durableWorkFinished, true);
  } });
  const owner = await accounts.resolveOrCreateAccount({ issuer: 'issuer', subject: 'lease-order-owner' });
  const membership = await accounts.bindDevice(owner.accountId, peer.deviceId);
  let entered!: () => void; const insideLease = new Promise<void>((resolve) => { entered = resolve; });
  let finish!: () => void; const gate = new Promise<void>((resolve) => { finish = resolve; });
  const leased = accounts.withActiveAuthorityLease({ accountId: owner.accountId, deviceId: peer.deviceId, generation: membership.authorityGeneration }, async () => {
    entered(); await gate; durableWorkFinished = true; return 'committed';
  });
  await insideLease;
  const removing = accounts.removeDevice(owner.accountId, peer.deviceId, 'lease ordering');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(purgeStarted, false);
  finish();
  assert.equal(await leased, 'committed');
  await removing;
  assert.equal(purgeStarted, true);
  await assert.rejects(
    accounts.withActiveAuthorityLease({ accountId: owner.accountId, deviceId: peer.deviceId, generation: membership.authorityGeneration }, async () => 'stale'),
    (error: any) => error?.code === 'ACCOUNT_AUTHORITY_REVOKED'
  );
});

test('one account cannot consume the global device registry through repeated claims', async (t) => {
  const stateDir = await temp(t, 'operator-account-quota-');
  const devices = new DeviceRegistryStore(stateDir);
  const accounts = new AccountDeviceRegistry(stateDir, devices);
  const owner = await accounts.resolveOrCreateAccount({ issuer: 'issuer', subject: 'quota-owner' });
  const peers: Array<{ deviceId: string; fingerprint: string }> = [];
  for (let i = 0; i < MAX_ACTIVE_DEVICES_PER_ACCOUNT; i += 1) {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const peer = {
      deviceId: crypto.randomUUID(), deviceName: `quota-device-${i}`, createdAt: new Date(0).toISOString(), publicKeyPem,
      fingerprint: crypto.createHash('sha256').update(publicKeyPem).digest('base64url')
    };
    await devices.registerVerifiedPeer(peer);
    await accounts.bindDevice(owner.accountId, peer.deviceId);
    peers.push(peer);
  }
  assert.equal((await accounts.listDevices(owner.accountId)).length, MAX_ACTIVE_DEVICES_PER_ACCOUNT);
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const extra = { deviceId: crypto.randomUUID(), deviceName: 'quota-extra', createdAt: new Date(0).toISOString(), publicKeyPem, fingerprint: crypto.createHash('sha256').update(publicKeyPem).digest('base64url') };
  await assert.rejects(accounts.assertCanBindDevice(owner.accountId, extra.deviceId), (error: any) => error?.code === 'ACCOUNT_DEVICE_QUOTA');
  await devices.registerVerifiedPeer(extra);
  await assert.rejects(accounts.bindDevice(owner.accountId, extra.deviceId), (error: any) => error?.code === 'ACCOUNT_DEVICE_QUOTA');
});

test('account erasure reclaims active device registrations', async (t) => {
  const { devices, accounts, peer } = await pairedFixture(t);
  const owner = await accounts.resolveOrCreateAccount({ issuer: 'issuer', subject: 'erase-registration-owner' });
  await accounts.bindDevice(owner.accountId, peer.deviceId);
  await accounts.eraseAccount(owner.accountId);
  assert.equal((await devices.listDevices()).some((device) => device.deviceId === peer.deviceId), false);
});


test('removed-device cycling is bounded by a per-account distinct-device lifetime quota', async (t) => {
  const stateDir = await temp(t, 'operator-account-history-quota-');
  const devices = new DeviceRegistryStore(stateDir);
  const accounts = new AccountDeviceRegistry(stateDir, devices);
  const owner = await accounts.resolveOrCreateAccount({ issuer: 'issuer', subject: 'history-quota-owner' });
  for (let i = 0; i < MAX_KNOWN_DEVICES_PER_ACCOUNT; i += 1) {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const peer = { deviceId: crypto.randomUUID(), deviceName: `history-${i}`, createdAt: new Date(0).toISOString(), publicKeyPem, fingerprint: crypto.createHash('sha256').update(publicKeyPem).digest('base64url') };
    await devices.registerVerifiedPeer(peer);
    await accounts.bindDevice(owner.accountId, peer.deviceId);
    await accounts.removeDevice(owner.accountId, peer.deviceId, 'cycle identity');
  }
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const extra = { deviceId: crypto.randomUUID(), deviceName: 'history-extra', createdAt: new Date(0).toISOString(), publicKeyPem, fingerprint: crypto.createHash('sha256').update(publicKeyPem).digest('base64url') };
  await assert.rejects(accounts.assertCanBindDevice(owner.accountId, extra.deviceId), (error: any) => error?.code === 'ACCOUNT_DEVICE_QUOTA');
});

test('account erasure keeps a device registration that has already moved to another account', async (t) => {
  const { devices, accounts, peer } = await pairedFixture(t);
  const oldOwner = await accounts.resolveOrCreateAccount({ issuer: 'issuer', subject: 'erase-old-owner' });
  const newOwner = await accounts.resolveOrCreateAccount({ issuer: 'issuer', subject: 'erase-new-owner' });
  await accounts.bindDevice(oldOwner.accountId, peer.deviceId);
  await accounts.removeDevice(oldOwner.accountId, peer.deviceId, 'moved');
  await accounts.bindDevice(newOwner.accountId, peer.deviceId);
  await accounts.eraseAccount(oldOwner.accountId);
  const registered = (await devices.listDevices()).find((device) => device.deviceId === peer.deviceId);
  assert.equal(registered?.status, 'active');
  assert.equal(await accounts.ownsDevice(newOwner.accountId, peer.deviceId), true);
});


test('account erasure preserves explicit revoked cryptographic device tombstones', async (t) => {
  const { devices, accounts, peer } = await pairedFixture(t);
  const owner = await accounts.resolveOrCreateAccount({ issuer: 'issuer', subject: 'erase-revoked-owner' });
  await accounts.bindDevice(owner.accountId, peer.deviceId);
  await devices.revokeDevice(peer.deviceId, 'device lost');
  await accounts.eraseAccount(owner.accountId);
  const retained = (await devices.listDevices()).find((device) => device.deviceId === peer.deviceId);
  assert.equal(retained?.status, 'revoked');
  assert.equal(retained?.revokedReason, 'device lost');
});

test('incoming bind revalidates registration after concurrent old-account erasure reclaim', async (t) => {
  const { stateDir, devices, accounts, peer } = await pairedFixture(t);
  const ownerA = await accounts.resolveOrCreateAccount({ issuer: 'issuer', subject: 'erase-race-a' });
  const ownerB = await accounts.resolveOrCreateAccount({ issuer: 'issuer', subject: 'erase-race-b' });
  await accounts.bindDevice(ownerA.accountId, peer.deviceId);
  await accounts.removeDevice(ownerA.accountId, peer.deviceId, 'prepare transfer race');

  const originalUnregister = devices.unregisterActiveDevice.bind(devices);
  let reclaimEntered!: () => void;
  const entered = new Promise<void>((resolve) => { reclaimEntered = resolve; });
  let releaseReclaim!: () => void;
  const gate = new Promise<void>((resolve) => { releaseReclaim = resolve; });
  devices.unregisterActiveDevice = (async (...args: Parameters<DeviceRegistryStore['unregisterActiveDevice']>) => {
    reclaimEntered();
    await gate;
    return await originalUnregister(...args);
  }) as DeviceRegistryStore['unregisterActiveDevice'];

  const erasing = accounts.eraseAccount(ownerA.accountId);
  await entered;
  const binding = accounts.bindDevice(ownerB.accountId, peer.deviceId);
  const rejected = assert.rejects(binding, (error: any) => error?.code === 'DEVICE_NOT_FOUND');
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseReclaim();
  await erasing;
  await rejected;
  assert.equal(await accounts.activeMembershipForDevice(peer.deviceId), null);
  assert.equal((await devices.listDevices()).some((device) => device.deviceId === peer.deviceId), false);
});
