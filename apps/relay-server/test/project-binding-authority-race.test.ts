import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccountDeviceRegistry } from '../../../src/core/account-device-registry.ts';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { DeviceRegistryStore, answerPairingChallenge } from '../../../src/core/device-registry.ts';
import { DeviceRoutingStore } from '../../../src/core/device-routing.ts';
import { RelayHub } from '../src/relay-hub.ts';

test('relay project routing cannot write a stale device binding after account authority is revoked', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-project-authority-race-'));
  const deviceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-project-device-race-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(deviceRoot, { recursive: true, force: true }); });

  const authorityIdentity = new DeviceIdentityStore(root, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceRoot, { platform: 'linux' });
  const devices = new DeviceRegistryStore(root);
  const authority = await authorityIdentity.loadOrCreate('Authority');
  const device = await deviceIdentity.loadOrCreate('Paired Device');
  const challenge = await devices.issuePairingChallenge(authority, {
    expectedPeerDeviceId: device.deviceId, ttlMs: 60_000
  });
  await devices.completePairing(await answerPairingChallenge(challenge, deviceIdentity));
  const accounts = new AccountDeviceRegistry(root, devices);
  const account = await accounts.resolveOrCreateAccount({ issuer: 'test-authority', subject: 'project-binding-revoke' });
  const membership = await accounts.bindDevice(account.accountId, device.deviceId);
  const hub = new RelayHub({ stateDir: root, identity: authorityIdentity, devices, accounts });
  t.after(() => hub.close());
  const routes = new DeviceRoutingStore(path.join(root, 'accounts', account.accountId), devices);

  // The normal path is permitted, and binds exactly this active membership.
  await hub.bindProject(account.accountId, 'safe-project', device.deviceId);
  assert.equal((await routes.listBindings()).find((x) => x.projectKey === 'safe-project')?.deviceId, device.deviceId);
  await routes.unbindProject('safe-project');

  const owns = accounts.ownsDevice.bind(accounts);
  const active = accounts.activeMembershipForDevice.bind(accounts);
  let removed = false;
  const revokeBetweenLookupAndCommit = async () => {
    if (removed) return;
    removed = true;
    await accounts.removeDevice(account.accountId, device.deviceId, 'revoked during project bind');
  };
  (accounts as any).ownsDevice = async (...args: Parameters<typeof owns>) => {
    const result = await owns(...args);
    if (result) await revokeBetweenLookupAndCommit();
    return result;
  };
  (accounts as any).activeMembershipForDevice = async (deviceId: string) => {
    const result = await active(deviceId);
    if (result) await revokeBetweenLookupAndCommit();
    return result;
  };

  await assert.rejects(hub.bindProject(account.accountId, 'stale-project', device.deviceId),
    (error: any) => error?.code === 'ACCOUNT_AUTHORITY_REVOKED');
  assert.equal(removed, true, 'the simulated concurrent removal must actually occur');
  assert.equal((await routes.listBindings()).some((x) => x.projectKey === 'stale-project'), false);
  assert.equal((await accounts.activeMembershipForDevice(device.deviceId)), null);
  assert.ok(membership.authorityGeneration >= 1);
});
