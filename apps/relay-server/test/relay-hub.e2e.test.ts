import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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

const testTempDirs = new WeakMap<object, string[]>();

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const dirs = testTempDirs.get(t) ?? [];
  dirs.push(dir);
  testTempDirs.set(t, dirs);
  return dir;
}

async function cleanupTempDirs(t: test.TestContext): Promise<void> {
  const dirs = testTempDirs.get(t) ?? [];
  testTempDirs.delete(t);
  for (const dir of dirs.reverse()) await fs.rm(dir, { recursive: true, force: true });
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
  t.after(() => cleanupTempDirs(t));
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
    supportedCapabilities: ['file.read', 'git.write'],
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
    supportedCapabilities: ['file.read', 'git.write'],
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
    kind: 'action',
    payload: {
      approvalAuthority: { accountId: crypto.randomUUID(), deviceId: crypto.randomUUID(), generation: 999 },
      action: { id: 'task-2', capability: 'file.read', risk: 'read', input: { path: 'a.txt' }, provenance: { kind: 'chatgpt' } }
    }
  });
  assert.deepEqual((second.delivery.payload as any).approvalAuthority, {
    accountId: account.accountId, deviceId: device.deviceId, generation: 1
  });
  await waitFor(async () => (await hub.deliveryCursor(device.deviceId)).lastAckedSeq === 2);
  assert.deepEqual(replayed, [second.delivery.id]);

  secondClient.stop();
  await secondRun;
});

test('relay intersects signed local capabilities with session scopes before routing', async (t) => {
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
  t.after(() => cleanupTempDirs(t));
  const { port } = await hub.listen('127.0.0.1', 0);

  const token = (await sessions.issue({
    subjectDeviceId: device.deviceId,
    audience: 'operator-relay',
    scopes: ['relay:connect', 'cap:file.read', 'cap:git.write'],
    ttlMs: 60_000
  })).token;
  const client = new RelayClient({
    stateDir: deviceState,
    url: `ws://127.0.0.1:${port}/device`,
    allowLoopbackInsecureWs: true,
    identity: deviceIdentity,
    socketFactory,
    getSessionToken: async () => token,
    supportedCapabilities: ['file.read'],
    onDelivery: async () => { throw new Error('no delivery expected'); }
  });
  const run = client.run();
  await waitFor(async () => (await hub.onlineDevices(account.accountId)).length === 1);
  assert.deepEqual((await hub.onlineDevices(account.accountId))[0]?.capabilities, ['file.read']);
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


test('capability downgrade retires an incompatible queued head and keeps the same reconnected client usable', { timeout: 20_000 }, async (t) => {
  const authorityState = await tempDir(t, 'operator-relay-queued-cap-authority-');
  const deviceState = await tempDir(t, 'operator-relay-queued-cap-device-');
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  const devices = new DeviceRegistryStore(authorityState);
  const device = await pairDevice(authorityIdentity, devices, deviceIdentity);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices);
  const accounts = new AccountDeviceRegistry(authorityState, devices);
  const deliveries = new RelayDeliveryStore(authorityState);
  const account = await accounts.resolveOrCreateAccount({ issuer: 'operator-test', subject: 'queued-cap-user' });
  await accounts.bindDevice(account.accountId, device.deviceId);
  const membership = (await accounts.listDevices(account.accountId)).find((entry) => entry.deviceId === device.deviceId);
  assert.ok(membership);
  const authority = { accountId: account.accountId, deviceId: device.deviceId, generation: membership.authorityGeneration };

  const hub = new RelayHub({ stateDir: authorityState, identity: authorityIdentity, devices, sessions, accounts, deliveries });
  t.after(() => hub.close());
  t.after(() => cleanupTempDirs(t));
  const { port } = await hub.listen('127.0.0.1', 0);
  const token = (await sessions.issue({
    subjectDeviceId: device.deviceId,
    audience: 'operator-relay',
    scopes: ['relay:connect', 'cap:file.read', 'cap:git.write'],
    ttlMs: 60_000
  })).token;

  const seen: string[] = [];
  const sockets: RelaySocketLike[] = [];
  let advertisedCapabilities: readonly string[] = ['file.read', 'git.write'];
  let capabilityReads = 0;
  let client!: RelayClient;
  client = new RelayClient({
    stateDir: deviceState,
    url: `ws://127.0.0.1:${port}/device`,
    allowLoopbackInsecureWs: true,
    identity: deviceIdentity,
    socketFactory: (url) => {
      const socket = socketFactory(url);
      sockets.push(socket);
      return socket;
    },
    getSessionToken: async () => token,
    getSupportedCapabilities: async () => {
      capabilityReads += 1;
      return advertisedCapabilities;
    },
    onDelivery: async (delivery) => { seen.push(delivery.id); },
    sleep: async () => undefined
  });
  const run = client.run();
  await waitFor(async () => {
    const online = await hub.onlineDevices(account.accountId);
    return online.some((entry) => entry.deviceId === device.deviceId && entry.capabilities.includes('git.write'));
  });

  const incompatible = await deliveries.enqueue(
    device.deviceId,
    'action',
    { action: { id: 'queued-git', capability: 'git.write', risk: 'write', input: {}, provenance: { kind: 'chatgpt' } } },
    authority,
    undefined,
    ['git.write']
  );
  const compatible = await deliveries.enqueue(
    device.deviceId,
    'action',
    { action: { id: 'queued-file', capability: 'file.read', risk: 'read', input: {}, provenance: { kind: 'chatgpt' } } },
    authority,
    undefined,
    ['file.read']
  );

  advertisedCapabilities = ['file.read'];
  sockets.at(-1)?.close(1012, 'simulate Git removal during network disconnect');
  await waitFor(async () => (await hub.deliveryCursor(device.deviceId)).lastAckedSeq === 2);
  client.stop();
  await run;

  assert.ok(capabilityReads >= 3, 'capabilities must be recomputed across downgrade and reconciliation reconnects');
  assert.deepEqual(seen, [compatible.id]);
  assert.deepEqual(await hub.deliveryCursor(device.deviceId), { lastAckedSeq: 2, highestEnqueuedSeq: 2 });
  const retired = await deliveries.retained(device.deviceId, incompatible.seq);
  assert.equal(retired?.status, 'expired');
  assert.deepEqual(retired?.payload, {});
  assert.equal(retired?.requiredCapabilities, undefined);
  assert.equal((await deliveries.retained(device.deviceId, compatible.seq))?.status, 'acked');
});

test('stale downgraded session cannot retire work after a restored-capability session supersedes it', { timeout: 20_000 }, async (t) => {
  const authorityState = await tempDir(t, 'operator-relay-cap-supersede-authority-');
  const lowState = await tempDir(t, 'operator-relay-cap-supersede-low-');
  const highState = await tempDir(t, 'operator-relay-cap-supersede-high-');
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(lowState, { platform: 'linux' });
  const devices = new DeviceRegistryStore(authorityState);
  const device = await pairDevice(authorityIdentity, devices, deviceIdentity);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices);
  const accounts = new AccountDeviceRegistry(authorityState, devices);
  const deliveries = new RelayDeliveryStore(authorityState);
  const account = await accounts.resolveOrCreateAccount({ issuer: 'operator-test', subject: 'cap-supersede-user' });
  await accounts.bindDevice(account.accountId, device.deviceId);
  const membership = (await accounts.listDevices(account.accountId)).find((entry) => entry.deviceId === device.deviceId);
  assert.ok(membership);
  const authority = { accountId: account.accountId, deviceId: device.deviceId, generation: membership.authorityGeneration };

  const queued = await deliveries.enqueue(
    device.deviceId,
    'action',
    { action: { id: 'restored-git', capability: 'git.write', risk: 'write', input: {}, provenance: { kind: 'chatgpt' } } },
    authority,
    undefined,
    ['git.write']
  );
  const hub = new RelayHub({ stateDir: authorityState, identity: authorityIdentity, devices, sessions, accounts, deliveries });
  t.after(() => hub.close());
  t.after(() => cleanupTempDirs(t));
  const { port } = await hub.listen('127.0.0.1', 0);
  const token = (await sessions.issue({
    subjectDeviceId: device.deviceId,
    audience: 'operator-relay',
    scopes: ['relay:connect', 'cap:file.read', 'cap:git.write'],
    ttlMs: 60_000
  })).token;

  const originalRetire = deliveries.expireUnroutableHeads.bind(deliveries);
  let enterRetirement!: () => void;
  let releaseRetirement!: () => void;
  let finishRetirement!: () => void;
  const retirementEntered = new Promise<void>((resolve) => { enterRetirement = resolve; });
  const retirementGate = new Promise<void>((resolve) => { releaseRetirement = resolve; });
  t.after(() => releaseRetirement());
  const retirementFinished = new Promise<void>((resolve) => { finishRetirement = resolve; });
  let retirementResult = -1;
  (deliveries as any).expireUnroutableHeads = async (...args: any[]) => {
    enterRetirement();
    await retirementGate;
    retirementResult = await (originalRetire as any)(...args);
    finishRetirement();
    return retirementResult;
  };

  let releaseLowReconnect!: () => void;
  const lowReconnectGate = new Promise<void>((resolve) => { releaseLowReconnect = resolve; });
  t.after(() => releaseLowReconnect());
  const lowClient = new RelayClient({
    stateDir: lowState,
    url: `ws://127.0.0.1:${port}/device`,
    allowLoopbackInsecureWs: true,
    identity: deviceIdentity,
    socketFactory,
    getSessionToken: async () => token,
    supportedCapabilities: ['file.read'],
    onDelivery: async () => { throw new Error('downgraded session must never receive Git work'); },
    sleep: async () => { await lowReconnectGate; }
  });
  const lowRun = lowClient.run();
  t.after(() => lowClient.stop());
  await retirementEntered;

  let highDeliverySeen!: () => void;
  let releaseHighDelivery!: () => void;
  const highDeliveryStarted = new Promise<void>((resolve) => { highDeliverySeen = resolve; });
  const highDeliveryGate = new Promise<void>((resolve) => { releaseHighDelivery = resolve; });
  t.after(() => releaseHighDelivery());
  const seen: string[] = [];
  const highClient = new RelayClient({
    stateDir: highState,
    url: `ws://127.0.0.1:${port}/device`,
    allowLoopbackInsecureWs: true,
    identity: deviceIdentity,
    socketFactory,
    getSessionToken: async () => token,
    supportedCapabilities: ['file.read', 'git.write'],
    onDelivery: async (delivery) => {
      seen.push(delivery.id);
      highDeliverySeen();
      await highDeliveryGate;
    },
    sleep: async () => undefined
  });
  const highRun = highClient.run();
  t.after(() => highClient.stop());
  await highDeliveryStarted;

  releaseRetirement();
  await retirementFinished;
  assert.equal(retirementResult, 0, 'superseded capability snapshot must not mutate the durable queue');
  assert.deepEqual(await hub.deliveryCursor(device.deviceId), { lastAckedSeq: 0, highestEnqueuedSeq: 1 });
  assert.equal((await deliveries.retained(device.deviceId, queued.seq))?.status, 'pending');

  releaseHighDelivery();
  await waitFor(async () => (await hub.deliveryCursor(device.deviceId)).lastAckedSeq === 1);
  assert.deepEqual(seen, [queued.id]);
  assert.equal((await deliveries.retained(device.deviceId, queued.seq))?.status, 'acked');

  lowClient.stop();
  releaseLowReconnect();
  highClient.stop();
  await Promise.all([lowRun, highRun]);
});

test('legacy unroutable queue head is terminalized and the device reconnects for compatible work', { timeout: 20_000 }, async (t) => {
  const authorityState = await tempDir(t, 'operator-relay-legacy-head-authority-');
  const deviceState = await tempDir(t, 'operator-relay-legacy-head-device-');
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  const devices = new DeviceRegistryStore(authorityState);
  const device = await pairDevice(authorityIdentity, devices, deviceIdentity);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices);
  const accounts = new AccountDeviceRegistry(authorityState, devices);
  const account = await accounts.resolveOrCreateAccount({ issuer: 'operator-test', subject: 'legacy-head-user' });
  await accounts.bindDevice(account.accountId, device.deviceId);
  const membership = (await accounts.listDevices(account.accountId)).find((entry) => entry.deviceId === device.deviceId);
  assert.ok(membership);
  const authority = { accountId: account.accountId, deviceId: device.deviceId, generation: membership.authorityGeneration };
  const legacy = {
    version: 1,
    streams: [{
      deviceId: device.deviceId,
      nextSeq: 2,
      lastAckedSeq: 0,
      deliveries: [{
        seq: 1,
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        kind: 'task.dispatch',
        payload: { taskId: 'legacy-unroutable' },
        authority,
        createdAt: new Date().toISOString(),
        status: 'pending'
      }]
    }]
  };
  await fs.writeFile(path.join(authorityState, 'relay-deliveries.json'), JSON.stringify(legacy, null, 2));
  const deliveries = new RelayDeliveryStore(authorityState);
  const hub = new RelayHub({ stateDir: authorityState, identity: authorityIdentity, devices, sessions, accounts, deliveries });
  t.after(() => hub.close());
  t.after(() => cleanupTempDirs(t));
  const { port } = await hub.listen('127.0.0.1', 0);
  const token = (await sessions.issue({
    subjectDeviceId: device.deviceId,
    audience: 'operator-relay',
    scopes: ['relay:connect', 'cap:file.read'],
    ttlMs: 60_000
  })).token;

  const seen: string[] = [];
  let capabilityReads = 0;
  const client = new RelayClient({
    stateDir: deviceState,
    url: `ws://127.0.0.1:${port}/device`,
    allowLoopbackInsecureWs: true,
    identity: deviceIdentity,
    socketFactory,
    getSessionToken: async () => token,
    getSupportedCapabilities: async () => {
      capabilityReads += 1;
      return ['file.read'];
    },
    onDelivery: async (delivery) => { seen.push(delivery.id); },
    sleep: async () => undefined
  });
  const run = client.run();
  t.after(() => client.stop());
  await waitFor(async () => capabilityReads >= 2 && (await hub.deliveryCursor(device.deviceId)).lastAckedSeq === 1);
  const retired = await deliveries.retained(device.deviceId, 1);
  assert.equal(retired?.status, 'expired');
  assert.deepEqual(retired?.payload, {});
  assert.equal(retired?.requiredCapabilities, undefined);

  const dispatched = await hub.dispatch({
    accountId: account.accountId,
    explicitDeviceId: device.deviceId,
    requiredCapabilities: ['file.read'],
    kind: 'action',
    payload: { action: { id: 'post-legacy-file', capability: 'file.read' } }
  });
  await waitFor(async () => (await hub.deliveryCursor(device.deviceId)).lastAckedSeq === 2);
  assert.deepEqual(seen, [dispatched.delivery.id]);

  client.stop();
  await run;
});

test('dispatch racing a capability downgrade is retired instead of falsely accepted', { timeout: 20_000 }, async (t) => {
  const authorityState = await tempDir(t, 'operator-relay-cap-race-authority-');
  const deviceState = await tempDir(t, 'operator-relay-cap-race-device-');
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  const devices = new DeviceRegistryStore(authorityState);
  const device = await pairDevice(authorityIdentity, devices, deviceIdentity);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices);
  const accounts = new AccountDeviceRegistry(authorityState, devices);
  const deliveries = new RelayDeliveryStore(authorityState);
  const account = await accounts.resolveOrCreateAccount({ issuer: 'operator-test', subject: 'cap-race-user' });
  await accounts.bindDevice(account.accountId, device.deviceId);

  const hub = new RelayHub({ stateDir: authorityState, identity: authorityIdentity, devices, sessions, accounts, deliveries });
  t.after(() => hub.close());
  t.after(() => cleanupTempDirs(t));
  const { port } = await hub.listen('127.0.0.1', 0);
  const token = (await sessions.issue({
    subjectDeviceId: device.deviceId,
    audience: 'operator-relay',
    scopes: ['relay:connect', 'cap:file.read', 'cap:git.write'],
    ttlMs: 60_000
  })).token;

  const sockets: RelaySocketLike[] = [];
  let advertisedCapabilities: readonly string[] = ['file.read', 'git.write'];  let capabilityReads = 0;
  const client = new RelayClient({
    stateDir: deviceState,
    url: `ws://127.0.0.1:${port}/device`,
    allowLoopbackInsecureWs: true,
    identity: deviceIdentity,
    socketFactory: (url) => {
      const socket = socketFactory(url);
      sockets.push(socket);
      return socket;
    },
    getSessionToken: async () => token,
    getSupportedCapabilities: async () => {
      capabilityReads += 1;
      return advertisedCapabilities;
    },
    onDelivery: async () => { throw new Error('retired stale capability delivery must never execute'); },
    sleep: async () => undefined
  });
  const run = client.run();
  t.after(() => client.stop());
  await waitFor(async () => (await hub.onlineDevices(account.accountId)).some((entry) => entry.capabilities.includes('git.write')));

  const originalEnqueue = deliveries.enqueue.bind(deliveries);
  let releaseEnqueue!: () => void;
  let enteredEnqueue!: () => void;
  const entered = new Promise<void>((resolve) => { enteredEnqueue = resolve; });
  const gate = new Promise<void>((resolve) => { releaseEnqueue = resolve; });
  t.after(() => releaseEnqueue());
  (deliveries as any).enqueue = async (...args: any[]) => {
    enteredEnqueue();
    await gate;
    return await (originalEnqueue as any)(...args);
  };

  const dispatching = hub.dispatch({
    accountId: account.accountId,
    explicitDeviceId: device.deviceId,
    requiredCapabilities: ['git.write'],
    kind: 'action',
    payload: { action: { id: 'stale-git-race', capability: 'git.write' } }
  });
  const rejected = assert.rejects(dispatching, (error: any) => error?.code === 'RELAY_DELIVERY_CAPABILITY_RETIRED');
  await entered;
  advertisedCapabilities = ['file.read'];
  sockets.at(-1)?.close(1012, 'downgrade while enqueue is paused');
  await waitFor(async () => (await hub.onlineDevices(account.accountId)).some((entry) => entry.capabilities.length === 1 && entry.capabilities[0] === 'file.read'));
  releaseEnqueue();
  await rejected;
  await waitFor(async () => capabilityReads >= 3 && (await hub.onlineDevices(account.accountId)).some((entry) => entry.capabilities.includes('file.read')));

  assert.deepEqual(await deliveries.pending(device.deviceId), []);
  assert.deepEqual(await hub.deliveryCursor(device.deviceId), { lastAckedSeq: 1, highestEnqueuedSeq: 1 });
  assert.equal((await deliveries.retained(device.deviceId, 1))?.status, 'expired');
  client.stop();
  await run;
});

test('account release invalidates the live socket before a concurrent dispatch can route', async (t) => {
  const authorityState = await tempDir(t, 'operator-relay-release-race-authority-');
  const deviceState = await tempDir(t, 'operator-relay-release-race-device-');
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  let hub: RelayHub | null = null;
  const devices = new DeviceRegistryStore(authorityState, {
    onRevoke: async (deviceId) => { hub?.invalidateDevice(deviceId, 'device revoked'); }
  });
  const device = await pairDevice(authorityIdentity, devices, deviceIdentity);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices, {
    onRevoke: async (jti) => { hub?.invalidateSession(jti, 'session revoked'); }
  });
  let releaseStarted!: () => void;
  let releaseFinish!: () => void;
  const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
  const finish = new Promise<void>((resolve) => { releaseFinish = resolve; });
  const accounts = new AccountDeviceRegistry(authorityState, devices, {
    onReleaseDevice: async (deviceId) => {
      hub?.invalidateDevice(deviceId, 'account authority removed');
      await sessions.purgeForDevice(deviceId);
      releaseStarted();
      await finish;
    }
  });  const account = await accounts.resolveOrCreateAccount({ issuer: 'operator-test', subject: 'release-race-user' });
  await accounts.bindDevice(account.accountId, device.deviceId);
  hub = new RelayHub({ stateDir: authorityState, identity: authorityIdentity, devices, sessions, accounts });
  t.after(() => hub?.close());
  t.after(() => cleanupTempDirs(t));
  const { port } = await hub.listen('127.0.0.1', 0);
  const issued = await sessions.issue({
    subjectDeviceId: device.deviceId,
    audience: 'operator-relay',
    scopes: ['relay:connect', 'cap:file.read'],
    ttlMs: 60_000
  });
  const client = new RelayClient({
    stateDir: deviceState,
    url: `ws://127.0.0.1:${port}/device`,
    allowLoopbackInsecureWs: true,
    identity: deviceIdentity,
    socketFactory,
    getSessionToken: async () => issued.token,
    supportedCapabilities: ['file.read'],
    onDelivery: async () => { throw new Error('no delivery expected after release starts'); }
  });
  const run = client.run();
  await waitFor(async () => (await hub!.onlineDevices(account.accountId)).length === 1);
  const removing = accounts.removeDevice(account.accountId, device.deviceId, 'ownership removed');
  await started;
  assert.deepEqual(await hub.onlineDevices(account.accountId), []);
  await assert.rejects(
    hub.dispatch({
      accountId: account.accountId,
      explicitDeviceId: device.deviceId,
      requiredCapabilities: ['file.read'],
      kind: 'action',
      payload: { action: { id: 'release-race', capability: 'file.read' } }
    }),
    (error: any) => ['ROUTE_DEVICE_OFFLINE', 'ROUTE_NO_DEVICE'].includes(error?.code)
  );
  releaseFinish();
  await removing;
  client.stop();
  await run;
});

async function liveRevocationFixture(t: test.TestContext, prefix: string) {
  const authorityState = await tempDir(t, `${prefix}-authority-`);
  const deviceState = await tempDir(t, `${prefix}-device-`);
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  let hub: RelayHub | null = null;
  const devices = new DeviceRegistryStore(authorityState, {
    onRevoke: async (deviceId) => { hub?.invalidateDevice(deviceId, 'device revoked'); }
  });
  const device = await pairDevice(authorityIdentity, devices, deviceIdentity);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices, {
    onRevoke: async (jti) => { hub?.invalidateSession(jti, 'session revoked'); }
  });
  const accounts = new AccountDeviceRegistry(authorityState, devices);
  const account = await accounts.resolveOrCreateAccount({ issuer: 'operator-test', subject: prefix });
  await accounts.bindDevice(account.accountId, device.deviceId);
  hub = new RelayHub({ stateDir: authorityState, identity: authorityIdentity, devices, sessions, accounts });
  t.after(() => hub?.close());
  t.after(() => cleanupTempDirs(t));
  const { port } = await hub.listen('127.0.0.1', 0);
  const issued = await sessions.issue({
    subjectDeviceId: device.deviceId,
    audience: 'operator-relay',
    scopes: ['relay:connect', 'cap:file.read'],
    ttlMs: 60_000
  });
  const client = new RelayClient({
    stateDir: deviceState,
    url: `ws://127.0.0.1:${port}/device`,
    allowLoopbackInsecureWs: true,
    identity: deviceIdentity,
    socketFactory,
    getSessionToken: async () => issued.token,
    supportedCapabilities: ['file.read'],
    onDelivery: async () => undefined
  });
  const run = client.run();
  await waitFor(async () => (await hub!.onlineDevices(account.accountId)).length === 1);
  return { hub, devices, sessions, account, device, issued, client, run };
}

test('revoking the authenticated session closes the already-open relay socket', async (t) => {
  const fixture = await liveRevocationFixture(t, 'session-live-revoke');
  await fixture.sessions.revoke(fixture.issued.payload.jti, 'operator revoked session');
  await waitFor(async () => (await fixture.hub!.onlineDevices(fixture.account.accountId)).length === 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await fixture.hub!.onlineDevices(fixture.account.accountId), []);
  await assert.rejects(
    fixture.hub!.dispatch({
      accountId: fixture.account.accountId,
      explicitDeviceId: fixture.device.deviceId,
      requiredCapabilities: ['file.read'],
      kind: 'action',
      payload: {}
    }),
    (error: any) => ['ROUTE_DEVICE_OFFLINE', 'ROUTE_NO_DEVICE'].includes(error?.code)
  );
  fixture.client.stop();
  await fixture.run;
});

test('revoking the paired device closes the already-open relay socket', async (t) => {
  const fixture = await liveRevocationFixture(t, 'device-live-revoke');
  await fixture.devices.revokeDevice(fixture.device.deviceId, 'device lost');
  await waitFor(async () => (await fixture.hub!.onlineDevices(fixture.account.accountId)).length === 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await fixture.hub!.onlineDevices(fixture.account.accountId), []);
  await assert.rejects(
    fixture.hub!.dispatch({
      accountId: fixture.account.accountId,
      explicitDeviceId: fixture.device.deviceId,
      requiredCapabilities: ['file.read'],
      kind: 'action',
      payload: {}
    }),
    (error: any) => ['ROUTE_DEVICE_INACTIVE', 'ROUTE_DEVICE_OFFLINE', 'ROUTE_NO_DEVICE'].includes(error?.code)
  );
  fixture.client.stop();
  await fixture.run;
});

test('dispatch paused before enqueue fails after account erasure and leaves no queue item', async (t) => {
  const authorityState = await tempDir(t, 'operator-relay-erase-race-authority-');
  const deviceState = await tempDir(t, 'operator-relay-erase-race-device-');
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  let hub: RelayHub | null = null;
  const devices = new DeviceRegistryStore(authorityState, {
    onRevoke: async (deviceId) => { hub?.invalidateDevice(deviceId, 'device revoked'); }
  });
  const device = await pairDevice(authorityIdentity, devices, deviceIdentity);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices, {
    onRevoke: async (jti) => { hub?.invalidateSession(jti, 'session revoked'); }
  });
  const deliveries = new RelayDeliveryStore(authorityState);
  const accounts = new AccountDeviceRegistry(authorityState, devices, {
    onReleaseDevice: async (deviceId) => {
      hub?.invalidateDevice(deviceId, 'account erased');
      await deliveries.purgeDevice(deviceId);
      await sessions.purgeForDevice(deviceId);
    }
  });
  const account = await accounts.resolveOrCreateAccount({ issuer: 'operator-test', subject: 'erase-race-user' });
  await accounts.bindDevice(account.accountId, device.deviceId);  let pauseDispatch!: () => void;
  let resumeDispatch!: () => void;
  const paused = new Promise<void>((resolve) => { pauseDispatch = resolve; });
  const resume = new Promise<void>((resolve) => { resumeDispatch = resolve; });
  let pausedOnce = false;
  hub = new RelayHub({
    stateDir: authorityState,
    identity: authorityIdentity,
    devices,
    sessions,
    accounts,
    deliveries,
    beforeEnqueue: async () => {
      if (pausedOnce) return;
      pausedOnce = true;
      pauseDispatch();
      await resume;
    }
  });
  t.after(() => hub?.close());
  t.after(() => cleanupTempDirs(t));
  const { port } = await hub.listen('127.0.0.1', 0);
  const issued = await sessions.issue({
    subjectDeviceId: device.deviceId,
    audience: 'operator-relay',
    scopes: ['relay:connect', 'cap:file.read'],
    ttlMs: 60_000
  });  const received: string[] = [];
  const client = new RelayClient({
    stateDir: deviceState,
    url: `ws://127.0.0.1:${port}/device`,
    allowLoopbackInsecureWs: true,
    identity: deviceIdentity,
    socketFactory,
    getSessionToken: async () => issued.token,
    supportedCapabilities: ['file.read'],
    onDelivery: async (delivery) => { received.push(delivery.id); }
  });
  const run = client.run();
  await waitFor(async () => (await hub!.onlineDevices(account.accountId)).length === 1);
  const dispatching = hub.dispatch({
    accountId: account.accountId,
    explicitDeviceId: device.deviceId,
    requiredCapabilities: ['file.read'],
    kind: 'action',
    payload: { action: { id: 'erase-race', capability: 'file.read' } }
  });
  await paused;
  await accounts.eraseAccount(account.accountId);
  assert.deepEqual(await hub.onlineDevices(), []);
  resumeDispatch();
  await assert.rejects(dispatching, (error: any) => error?.code === 'RELAY_AUTHORITY_CHANGED');
  assert.deepEqual(await deliveries.cursor(device.deviceId), { lastAckedSeq: 0, highestEnqueuedSeq: 0 });
  assert.deepEqual(received, []);
  client.stop();
  await run;
});

test('device transfer preserves relay cursor continuity without exposing old-owner payloads', async (t) => {
  const authorityState = await tempDir(t, 'operator-relay-rebind-authority-');
  const deviceState = await tempDir(t, 'operator-relay-rebind-device-');
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  let hub: RelayHub | null = null;
  const devices = new DeviceRegistryStore(authorityState);
  const device = await pairDevice(authorityIdentity, devices, deviceIdentity);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices);
  const deliveries = new RelayDeliveryStore(authorityState);
  const accounts = new AccountDeviceRegistry(authorityState, devices, {
    onReleaseDevice: async (deviceId) => {
      hub?.invalidateDevice(deviceId, 'ownership transferred');
      await deliveries.purgeDevice(deviceId);
      await sessions.purgeForDevice(deviceId);
    }
  });
  const ownerA = await accounts.resolveOrCreateAccount({ issuer: 'operator-test', subject: 'owner-a' });
  const ownerB = await accounts.resolveOrCreateAccount({ issuer: 'operator-test', subject: 'owner-b' });
  await accounts.bindDevice(ownerA.accountId, device.deviceId);
  hub = new RelayHub({ stateDir: authorityState, identity: authorityIdentity, devices, sessions, accounts, deliveries });
  t.after(() => hub?.close());
  t.after(() => cleanupTempDirs(t));
  const { port } = await hub.listen('127.0.0.1', 0);
  const url = `ws://127.0.0.1:${port}/device`;
  const issue = async () => (await sessions.issue({
    subjectDeviceId: device.deviceId,
    audience: 'operator-relay',
    scopes: ['relay:connect', 'cap:file.read'],
    ttlMs: 60_000
  })).token;
  const ownerAToken = await issue();
  const seenA: number[] = [];
  const clientA = new RelayClient({
    stateDir: deviceState, url, allowLoopbackInsecureWs: true, identity: deviceIdentity, socketFactory,
    getSessionToken: async () => ownerAToken,
    supportedCapabilities: ['file.read'],
    onDelivery: async (delivery) => { seenA.push(delivery.seq); }
  });
  const runA = clientA.run();
  await waitFor(async () => (await hub!.onlineDevices(ownerA.accountId)).length === 1);
  for (let seq = 1; seq <= 3; seq += 1) {
    await hub.dispatch({ accountId: ownerA.accountId, explicitDeviceId: device.deviceId,
      requiredCapabilities: ['file.read'], kind: 'action', payload: { ownerASecret: `old-${seq}` } });
    await waitFor(async () => (await hub!.deliveryCursor(device.deviceId)).lastAckedSeq === seq);
  }
  assert.deepEqual(seenA, [1, 2, 3]);
  clientA.stop();
  await runA;
  await accounts.removeDevice(ownerA.accountId, device.deviceId, 'transfer');
  assert.deepEqual(await deliveries.cursor(device.deviceId), { lastAckedSeq: 3, highestEnqueuedSeq: 3 });
  const queueAfterTransfer = await fs.readFile(path.join(authorityState, 'relay-deliveries.json'), 'utf8');
  assert.equal(queueAfterTransfer.includes('old-1'), false);
  assert.equal(queueAfterTransfer.includes('old-2'), false);
  assert.equal(queueAfterTransfer.includes('old-3'), false);
  await assert.rejects(
    sessions.verify(ownerAToken, { audience: 'operator-relay', requiredScopes: ['relay:connect'], expectedSubjectDeviceId: device.deviceId }),
    (error: any) => ['SESSION_NOT_FOUND', 'SESSION_REVOKED'].includes(error?.code)
  );
  await accounts.bindDevice(ownerB.accountId, device.deviceId);
  const ownerBToken = await issue();
  const seenB: number[] = [];
  const clientB = new RelayClient({
    stateDir: deviceState, url, allowLoopbackInsecureWs: true, identity: deviceIdentity, socketFactory,
    getSessionToken: async () => ownerBToken,
    supportedCapabilities: ['file.read'],
    onDelivery: async (delivery) => { seenB.push(delivery.seq); }
  });
  const runB = clientB.run();
  await waitFor(async () => (await hub!.onlineDevices(ownerB.accountId)).length === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(seenB, []);
  const fresh = await hub.dispatch({
    accountId: ownerB.accountId,
    explicitDeviceId: device.deviceId,
    requiredCapabilities: ['file.read'],
    kind: 'action',
    payload: { owner: 'b', fresh: true }
  });
  assert.equal(fresh.delivery.seq, 4);
  await waitFor(async () => (await hub!.deliveryCursor(device.deviceId)).lastAckedSeq === 4);
  assert.deepEqual(seenB, [4]);
  assert.deepEqual(await clientB.state(), { version: 1, lastAckedServerSeq: 4 });
  clientB.stop();
  await runB;
});


async function openBareSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return socket;
}

async function rejectedUpgradeStatus(url: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    socket.once('unexpected-response', (request, response) => {
      settled = true;
      const status = response.statusCode ?? 0;
      response.resume();
      request.destroy();
      try { socket.terminate(); } catch { /* rejected upgrade already owns shutdown */ }
      resolve(status);
    });
    socket.once('open', () => { socket.terminate(); if (!settled) reject(new Error('upgrade unexpectedly succeeded')); });
    socket.once('error', (error) => { if (!settled) reject(error); });
  });
}

test('relay caps unauthenticated live WebSocket population per client before hello', async (t) => {
  const state = await tempDir(t, 'operator-relay-live-cap-');
  const hub = new RelayHub({
    stateDir: state,
    upgradeLimitPerMinute: 100,
    maxLiveConnections: 10,
    maxLiveConnectionsPerClient: 1
  });
  const { port } = await hub.listen('127.0.0.1', 0);
  t.after(() => hub.close());
  t.after(() => cleanupTempDirs(t));
  const url = `ws://127.0.0.1:${port}/device`;
  const first = await openBareSocket(url);
  assert.equal(await rejectedUpgradeStatus(url), 429);
  const closed = new Promise<void>((resolve) => first.once('close', () => resolve()));
  first.terminate();
  await closed;
});

test('relay caps unauthenticated WebSocket connection churn before allocating more clients', async (t) => {
  const state = await tempDir(t, 'operator-relay-churn-cap-');
  const hub = new RelayHub({ stateDir: state, upgradeLimitPerMinute: 2, maxLiveConnectionsPerClient: 10 });
  const { port } = await hub.listen('127.0.0.1', 0);
  t.after(() => hub.close());
  t.after(() => cleanupTempDirs(t));
  const url = `ws://127.0.0.1:${port}/device`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const socket = await openBareSocket(url);
    socket.terminate();
    await new Promise((resolve) => socket.once('close', resolve));
  }
  assert.equal(await rejectedUpgradeStatus(url), 429);
});

test('relay device hello quota stops repeated token verification before expensive auth', async (t) => {
  const state = await tempDir(t, 'operator-relay-hello-cap-');
  const deviceId = '123e4567-e89b-42d3-a456-426614174000';
  let verifyCalls = 0;
  const sessions = { async verify() { verifyCalls += 1; throw new Error('invalid token'); } };
  const hub = new RelayHub({
    stateDir: state,
    sessions: sessions as any,
    upgradeLimitPerMinute: 100,
    deviceHelloLimitPerFiveMinutes: 1
  });
  const { port } = await hub.listen('127.0.0.1', 0);
  t.after(() => hub.close());
  t.after(() => cleanupTempDirs(t));
  const url = `ws://127.0.0.1:${port}/device`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const socket = await openBareSocket(url);
    socket.send(JSON.stringify({
      type: 'hello', payload: { protocol: 1, deviceId, fingerprint: 'f', resumeAfterSeq: 0,
        sentAt: new Date().toISOString(), nonce: 'abcdefghijklmnop' },
      signature: 'a'.repeat(40), sessionToken: 'invalid'
    }));
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
  }
  assert.equal(verifyCalls, 1);
});

test('relay device hello quota is isolated per device identity', async (t) => {
  const state = await tempDir(t, 'operator-relay-hello-isolation-');
  const firstDevice = '123e4567-e89b-42d3-a456-426614174000';
  const secondDevice = '123e4567-e89b-42d3-a456-426614174001';
  let verifyCalls = 0;
  const sessions = { async verify() { verifyCalls += 1; throw new Error('invalid token'); } };
  const hub = new RelayHub({ stateDir: state, sessions: sessions as any,
    upgradeLimitPerMinute: 100, deviceHelloLimitPerFiveMinutes: 1 });
  const { port } = await hub.listen('127.0.0.1', 0);
  t.after(() => hub.close());
  t.after(() => cleanupTempDirs(t));
  const url = `ws://127.0.0.1:${port}/device`;
  const sendHello = async (deviceId: string) => {
    const socket = await openBareSocket(url);
    socket.send(JSON.stringify({ type: 'hello', payload: { protocol: 1, deviceId,
      fingerprint: 'f', resumeAfterSeq: 0, sentAt: new Date().toISOString(), nonce: 'abcdefghijklmnop' },
      signature: 'a'.repeat(40), sessionToken: 'invalid' }));
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
  };
  await sendHello(firstDevice);
  await sendHello(firstDevice);
  await sendHello(secondDevice);
  assert.equal(verifyCalls, 2);
});

test('authority lease prevents release purge from overtaking an in-flight delivery enqueue', async (t) => {
  const authorityState = await tempDir(t, 'operator-relay-enqueue-lease-authority-');
  const deviceState = await tempDir(t, 'operator-relay-enqueue-lease-device-');
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  let hub: RelayHub | null = null;
  const devices = new DeviceRegistryStore(authorityState);
  const device = await pairDevice(authorityIdentity, devices, deviceIdentity);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices);
  const deliveries = new RelayDeliveryStore(authorityState);
  let durableEnqueueFinished = false;
  let purgeStarted = false;
  const accounts = new AccountDeviceRegistry(authorityState, devices, { onReleaseDevice: async (deviceId) => {
    purgeStarted = true;
    assert.equal(durableEnqueueFinished, true);
    hub?.invalidateDevice(deviceId, 'account authority removed');
    await deliveries.purgeDevice(deviceId); await sessions.purgeForDevice(deviceId);
  } });
  const account = await accounts.resolveOrCreateAccount({ issuer: 'operator-test', subject: 'enqueue-lease-owner' });
  await accounts.bindDevice(account.accountId, device.deviceId);
  hub = new RelayHub({ stateDir: authorityState, identity: authorityIdentity, devices, sessions, accounts, deliveries });
  t.after(() => hub?.close());
  t.after(() => cleanupTempDirs(t));
  const { port } = await hub.listen('127.0.0.1', 0);
  const issued = await sessions.issue({ subjectDeviceId: device.deviceId, audience: 'operator-relay', scopes: ['relay:connect', 'cap:file.read'], ttlMs: 60_000 });
  const client = new RelayClient({
    stateDir: deviceState, url: `ws://127.0.0.1:${port}/device`, allowLoopbackInsecureWs: true,
    identity: deviceIdentity, socketFactory, getSessionToken: async () => issued.token,
    supportedCapabilities: ['file.read'],
    onDelivery: async () => undefined
  });
  const run = client.run();
  await waitFor(async () => (await hub!.onlineDevices(account.accountId)).length === 1);
  const originalEnqueue = deliveries.enqueue.bind(deliveries);
  let storedDelivery: any = null;
  let enqueueEntered!: () => void; const entered = new Promise<void>((resolve) => { enqueueEntered = resolve; });
  let finishEnqueue!: () => void; const enqueueGate = new Promise<void>((resolve) => { finishEnqueue = resolve; });
  (deliveries as any).enqueue = async (...args: any[]) => {
    enqueueEntered(); await enqueueGate;
    const stored = await (originalEnqueue as any)(...args);
    storedDelivery = stored;
    durableEnqueueFinished = true;
    return stored;
  };
  const dispatching = hub.dispatch({
    accountId: account.accountId, explicitDeviceId: device.deviceId,
    requiredCapabilities: ['file.read'], kind: 'action',
    payload: { action: { id: 'enqueue-lease', capability: 'file.read' } },
    idempotencyKey: 'f'.repeat(64)
  });
  await entered;
  const removing = accounts.removeDevice(account.accountId, device.deviceId, 'enqueue lease release');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(purgeStarted, false);
  finishEnqueue();
  await assert.rejects(dispatching, (error: any) => error?.code === 'RELAY_AUTHORITY_CHANGED');
  await removing;
  assert.equal(purgeStarted, true);
  assert.ok(storedDelivery);
  const retained = await deliveries.retained(device.deviceId, storedDelivery.seq);
  assert.equal(retained?.status, 'expired');
  assert.deepEqual(retained?.payload, {});
  assert.equal(retained?.authority, undefined);
  assert.equal(await deliveries.findIdempotent('f'.repeat(64)), null);
  client.stop();
  await run;
});
