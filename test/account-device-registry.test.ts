import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccountDeviceRegistry } from '../src/core/account-device-registry.ts';
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
  const authority = new DeviceIdentityStore(authorityDir);
  const peerStore = new DeviceIdentityStore(peerDir);
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
