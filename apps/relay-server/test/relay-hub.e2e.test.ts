import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { AccountDeviceRegistry } from '../../../src/core/account-device-registry.ts';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { DeviceRegistryStore, answerPairingChallenge } from '../../../src/core/device-registry.ts';
import { RelayClient, type RelaySocketLike } from '../../../src/core/relay-client.ts';
import { RelayDeliveryStore } from '../../../src/core/relay-delivery-store.ts';
import { DeviceSessionTokenStore } from '../../../src/core/session-token.ts';
import { RelayHub } from '../src/relay-hub.ts';

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`condition not satisfied within ${timeoutMs} ms`);
}

function socketFactory(url: string): RelaySocketLike {
  return new WebSocket(url) as unknown as RelaySocketLike;
}

async function pairDevice(authorityIdentity: DeviceIdentityStore, devices: DeviceRegistryStore, deviceIdentity: DeviceIdentityStore) {
  const authority = await authorityIdentity.loadOrCreate('Relay Authority');
  const device = await deviceIdentity.loadOrCreate('Paired Device');
  const challenge = await devices.issuePairingChallenge(authority, {
    expectedPeerDeviceId: device.deviceId,
    ttlMs: 60_000
  });
  await devices.completePairing(await answerPairingChallenge(challenge, deviceIdentity));
  return device;
}

test('real relay routes paired device delivery, durably ACKs it, and reconnects without replay', async (t) => {
  const authorityState = await tempDir(t, 'operator-relay-e2e-authority-');
  const deviceState = await tempDir(t, 'operator-relay-e2e-device-');

  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  const devices = new DeviceRegistryStore(authorityState);
  const device = await pairDevice(authorityIdentity, devices, deviceIdentity);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices);
  const accounts = new AccountDeviceRegistry(authorityState, devices);
  const deliveries = new RelayDeliveryStore(authorityState);
  const account = await accounts.resolveOrCreateAccount({ issuer: 'operator-test', subject: 'relay-e2e-user' });
  await accounts.bindDevice(account.accountId, device.deviceId);

  const hub = new RelayHub({
    stateDir: authorityState,
    identity: authorityIdentity,
    devices,
    sessions,
    accounts,
    deliveries
  });
  t.after(() => hub.close());
  const { port } = await hub.listen('127.0.0.1', 0);
  const url = `ws://127.0.0.1:${port}/device`;

  async function issueToken(): Promise<string> {
    return (await sessions.issue({
      subjectDeviceId: device.deviceId,
      audience: 'operator-relay',
      scopes: ['relay:connect', 'cap:file.read', 'cap:git.write'],
      ttlMs: 60_000
    })).token;
  }

  const firstDeliveries: string[] = [];
  const firstClient = new RelayClient({
    stateDir: deviceState,
    url,
    allowLoopbackInsecureWs: true,
    identity: deviceIdentity,
    socketFactory,
    getSessionToken: issueToken,
    onDelivery: async (delivery) => { firstDeliveries.push(delivery.id); }
  });
  const firstRun = firstClient.run();

  await waitFor(async () => (await hub.onlineDevices(account.accountId)).some((entry) => entry.deviceId === device.deviceId));
  await hub.bindProject(account.accountId, 'project-main', device.deviceId);
  const dispatched = await hub.dispatch({
    accountId: account.accountId,
    projectKey: 'project-main',
    requiredCapabilities: ['git.write'],
    kind: 'task.dispatch',
    payload: { taskId: 'task-1', action: 'git.write' }
  });
  assert.equal(dispatched.route.deviceId, device.deviceId);
  assert.equal(dispatched.route.reason, 'project-binding');

  await waitFor(async () => (await hub.deliveryCursor(device.deviceId)).lastAckedSeq === 1);
  assert.deepEqual(firstDeliveries, [dispatched.delivery.id]);
  assert.deepEqual(await hub.deliveryCursor(device.deviceId), { lastAckedSeq: 1, highestEnqueuedSeq: 1 });

  firstClient.stop();
  await firstRun;
  await waitFor(async () => !(await hub.onlineDevices(account.accountId)).some((entry) => entry.deviceId === device.deviceId));

  const replayed: string[] = [];
  const secondClient = new RelayClient({
    stateDir: deviceState,
    url,
    allowLoopbackInsecureWs: true,
    identity: deviceIdentity,
    socketFactory,
    getSessionToken: issueToken,
    onDelivery: async (delivery) => { replayed.push(delivery.id); }
  });
  const secondRun = secondClient.run();
  await waitFor(async () => (await hub.onlineDevices(account.accountId)).some((entry) => entry.deviceId === device.deviceId));

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(replayed, []);
  assert.deepEqual(await hub.deliveryCursor(device.deviceId), { lastAckedSeq: 1, highestEnqueuedSeq: 1 });

  const second = await hub.dispatch({
    accountId: account.accountId,
    explicitDeviceId: device.deviceId,
    requiredCapabilities: ['file.read'],
    kind: 'task.dispatch',
    payload: { taskId: 'task-2', action: 'file.read' }
  });
  await waitFor(async () => (await hub.deliveryCursor(device.deviceId)).lastAckedSeq === 2);
  assert.deepEqual(replayed, [second.delivery.id]);

  secondClient.stop();
  await secondRun;
});

test('relay refuses account routing when connected token lacks required capability', async (t) => {
  const authorityState = await tempDir(t, 'operator-relay-cap-authority-');
  const deviceState = await tempDir(t, 'operator-relay-cap-device-');
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  const devices = new DeviceRegistryStore(authorityState);
  const device = await pairDevice(authorityIdentity, devices, deviceIdentity);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices);
  const accounts = new AccountDeviceRegistry(authorityState, devices);
  const account = await accounts.resolveOrCreateAccount({ issuer: 'operator-test', subject: 'limited-user' });
  await accounts.bindDevice(account.accountId, device.deviceId);
  const hub = new RelayHub({ stateDir: authorityState, identity: authorityIdentity, devices, sessions, accounts });
  t.after(() => hub.close());
  const { port } = await hub.listen('127.0.0.1', 0);

  const token = (await sessions.issue({
    subjectDeviceId: device.deviceId,
    audience: 'operator-relay',
    scopes: ['relay:connect', 'cap:file.read'],
    ttlMs: 60_000
  })).token;
  const client = new RelayClient({
    stateDir: deviceState,
    url: `ws://127.0.0.1:${port}/device`,
    allowLoopbackInsecureWs: true,
    identity: deviceIdentity,
    socketFactory,
    getSessionToken: async () => token,
    onDelivery: async () => { throw new Error('no delivery expected'); }
  });
  const run = client.run();
  await waitFor(async () => (await hub.onlineDevices(account.accountId)).length === 1);
  await assert.rejects(
    hub.dispatch({
      accountId: account.accountId,
      explicitDeviceId: device.deviceId,
      requiredCapabilities: ['git.write'],
      kind: 'task.dispatch',
      payload: {}
    }),
    (error: any) => error?.code === 'ROUTE_CAPABILITY_MISMATCH'
  );
  client.stop();
  await run;
});
