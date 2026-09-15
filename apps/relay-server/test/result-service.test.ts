import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccountDeviceRegistry } from '../../../src/core/account-device-registry.ts';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { DeviceRegistryStore, answerPairingChallenge } from '../../../src/core/device-registry.ts';
import { DeviceResetStore } from '../../../src/core/device-reset.ts';
import { RelayDeliveryStore } from '../../../src/core/relay-delivery-store.ts';
import { RelayResultStore } from '../../../src/core/relay-result-store.ts';
import { DeviceSessionTokenStore } from '../../../src/core/session-token.ts';
import { RelayResultService } from '../src/result-service.ts';

const tempDirs = new WeakMap<test.TestContext, string[]>();

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const dirs = tempDirs.get(t) ?? [];
  dirs.push(dir);
  tempDirs.set(t, dirs);
  return dir;
}

function cleanupAfter(t: test.TestContext, service: RelayResultService): void {
  t.after(async () => {
    await service.close();
    for (const dir of [...(tempDirs.get(t) ?? [])].reverse()) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.delete(t);
  });
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
  cleanupAfter(t, service);
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


test('device session rotation revokes the old JTI and stops after ownership removal or transfer', async (t) => {
  const authorityState = await tempDir(t, 'operator-session-rotate-authority-');
  const deviceState = await tempDir(t, 'operator-session-rotate-device-');
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  const devices = new DeviceRegistryStore(authorityState);
  const device = await pairDevice(authorityIdentity, devices, deviceIdentity);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices);
  const accounts = new AccountDeviceRegistry(authorityState, devices, {
    onReleaseDevice: async (deviceId) => { await sessions.purgeForDevice(deviceId); }
  });
  const ownerA = await accounts.resolveOrCreateAccount({ issuer: 'test', subject: 'owner-a' });
  const ownerB = await accounts.resolveOrCreateAccount({ issuer: 'test', subject: 'owner-b' });
  await accounts.bindDevice(ownerA.accountId, device.deviceId);
  const service = new RelayResultService({ stateDir: authorityState, identity: authorityIdentity, devices, sessions, accounts });
  cleanupAfter(t, service);
  const { port } = await service.listen('127.0.0.1', 0);
  const rotateUrl = `http://127.0.0.1:${port}/v1/device-session/rotate`;
  const original = await sessions.issue({ subjectDeviceId: device.deviceId, audience: 'operator-relay', scopes: ['relay:connect', 'relay:result'], ttlMs: 60_000 });
  const rotatedResponse = await fetch(rotateUrl, { method: 'POST', headers: { authorization: `Bearer ${original.token}` } });
  assert.equal(rotatedResponse.status, 200);
  const rotatedBody = await rotatedResponse.json() as any;
  assert.notEqual(rotatedBody.session.token, original.token);
  assert.deepEqual(rotatedBody.session.scopes, ['relay:connect', 'relay:result']);
  const retryResponse = await fetch(rotateUrl, { method: 'POST', headers: { authorization: `Bearer ${original.token}` } });
  assert.equal(retryResponse.status, 200);
  assert.equal((await retryResponse.json() as any).session.token, rotatedBody.session.token);
  await assert.rejects(sessions.verify(original.token, { audience: 'operator-relay' }), (error: any) => error?.code === 'SESSION_REVOKED');
  await sessions.verify(rotatedBody.session.token, { audience: 'operator-relay', requiredScopes: ['relay:connect', 'relay:result'] });
  await accounts.removeDevice(ownerA.accountId, device.deviceId, 'transfer');
  await accounts.bindDevice(ownerB.accountId, device.deviceId);
  const denied = await fetch(rotateUrl, { method: 'POST', headers: { authorization: `Bearer ${rotatedBody.session.token}` } });
  assert.equal(denied.status, 401);
  assert.ok(['SESSION_NOT_FOUND', 'SESSION_REVOKED', 'SESSION_AUTHORITY_REVOKED'].includes((await denied.json() as any).error.code));
});


test('result service physically prunes expired payloads at startup and periodically without a read', async (t) => {
  const state = await tempDir(t, 'operator-result-gc-');
  let nowMs = Date.parse('2026-09-14T00:00:00.000Z');
  const results = new RelayResultStore(state, { clock: () => new Date(nowMs), retentionMs: 60_000 });
  const deviceId = '123e4567-e89b-42d3-a456-426614174000';
  const firstId = '123e4567-e89b-42d3-a456-426614174001';
  await results.put(deviceId, 1, firstId, { output: { secret: 'startup-sensitive-result' } });
  nowMs += 60_001;

  const service = new RelayResultService({ stateDir: state, results, gcIntervalMs: 20 });
  const { port } = await service.listen('127.0.0.1', 0);
  assert.ok(port > 0);
  cleanupAfter(t, service);

  const file = path.join(state, 'relay-results.json');
  let persisted = await fs.readFile(file, 'utf8');
  assert.equal(persisted.includes('startup-sensitive-result'), false);
  assert.deepEqual(JSON.parse(persisted).streams, []);
  const secondId = '123e4567-e89b-42d3-a456-426614174002';
  await results.put(deviceId, 2, secondId, { output: { secret: 'periodic-sensitive-result' } });
  nowMs += 60_001;

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    persisted = await fs.readFile(file, 'utf8');
    if (!persisted.includes('periodic-sensitive-result')) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  persisted = await fs.readFile(file, 'utf8');
  assert.equal(persisted.includes('periodic-sensitive-result'), false);
  assert.deepEqual(JSON.parse(persisted).streams, []);
});


test('result endpoint bounds pre-auth token verification attempts per client', async (t) => {
  const state = await tempDir(t, 'operator-result-rate-preauth-');
  let verifyCalls = 0;
  const sessions = { async verify() { verifyCalls += 1; throw new Error('invalid token'); } };
  const service = new RelayResultService({
    stateDir: state, sessions: sessions as any, requestLimitPerMinute: 2, deviceLimitPerMinute: 100
  });
  const { port } = await service.listen('127.0.0.1', 0);
  cleanupAfter(t, service);
  const url = `http://127.0.0.1:${port}/v1/device-result`;
  for (let index = 0; index < 2; index += 1) {
    const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer invalid' }, body: '{}' });
    assert.notEqual(response.status, 429);
  }
  const blocked = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer invalid' }, body: '{}' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.has('retry-after'), true);
  assert.equal(verifyCalls, 2);
});

test('result endpoint separately bounds a verified device before durable result work', async (t) => {
  const state = await tempDir(t, 'operator-result-rate-device-');
  const deviceId = '123e4567-e89b-42d3-a456-426614174000';
  let verifyCalls = 0;
  const sessions = { async verify() { verifyCalls += 1; return { subjectDeviceId: deviceId }; } };
  const service = new RelayResultService({
    stateDir: state, sessions: sessions as any, requestLimitPerMinute: 100, deviceLimitPerMinute: 1
  });
  const { port } = await service.listen('127.0.0.1', 0);
  cleanupAfter(t, service);
  const url = `http://127.0.0.1:${port}/v1/device-result`;
  const first = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer valid' }, body: '{}' });
  assert.equal(first.status, 400);
  const blocked = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer valid' }, body: '{}' });
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json() as any).error.code, 'RELAY_RESULT_RATE_LIMITED');
  assert.equal(verifyCalls, 2);
});

test('device self-reset revokes hosted authority and recovers the same completion receipt after session purge', async (t) => {
  const authorityState = await tempDir(t, 'operator-device-reset-authority-');
  const deviceState = await tempDir(t, 'operator-device-reset-device-');
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  const devices = new DeviceRegistryStore(authorityState);
  const device = await pairDevice(authorityIdentity, devices, deviceIdentity);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices);
  const accounts = new AccountDeviceRegistry(authorityState, devices, {
    onReleaseDevice: async (deviceId) => { await sessions.purgeForDevice(deviceId); }
  });
  const account = await accounts.resolveOrCreateAccount({ issuer: 'test', subject: 'reset-owner' });
  await accounts.bindDevice(account.accountId, device.deviceId);
  const issued = await sessions.issue({ subjectDeviceId: device.deviceId, audience: 'operator-relay', scopes: ['relay:connect', 'relay:result'], ttlMs: 60_000 });
  const service = new RelayResultService({ stateDir: authorityState, identity: authorityIdentity, devices, sessions, accounts });
  cleanupAfter(t, service);
  const { port } = await service.listen('127.0.0.1', 0);
  const url = `http://127.0.0.1:${port}/v1/device-self/reset`;
  const first = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${issued.token}` } });
  assert.equal(first.status, 200);
  const firstBody = await first.json() as any;
  assert.equal(firstBody.reset.status, 'complete');
  assert.equal(firstBody.reset.deviceId, device.deviceId);
  assert.deepEqual(await accounts.listDevices(account.accountId), []);
  const registered = (await devices.listDevices()).find((candidate) => candidate.deviceId === device.deviceId);
  assert.equal(registered?.status, 'revoked');
  assert.equal((await sessions.listIssued()).some((record) => record.subjectDeviceId === device.deviceId), false);

  const retry = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${issued.token}` } });
  assert.equal(retry.status, 200);
  const retryBody = await retry.json() as any;
  assert.deepEqual(retryBody.reset, firstBody.reset);
});


test('old self-reset receipt cannot revoke a newer rebound authority generation', async (t) => {
  const authorityState = await tempDir(t, 'operator-device-reset-superseded-authority-');
  const deviceState = await tempDir(t, 'operator-device-reset-superseded-device-');
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  const devices = new DeviceRegistryStore(authorityState);
  const device = await pairDevice(authorityIdentity, devices, deviceIdentity);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices);
  const accounts = new AccountDeviceRegistry(authorityState, devices);
  const resets = new DeviceResetStore(authorityState);
  const ownerA = await accounts.resolveOrCreateAccount({ issuer: 'test', subject: 'reset-old-owner' });
  const ownerB = await accounts.resolveOrCreateAccount({ issuer: 'test', subject: 'reset-new-owner' });
  const firstMembership = await accounts.bindDevice(ownerA.accountId, device.deviceId);
  const issued = await sessions.issue({ subjectDeviceId: device.deviceId, audience: 'operator-relay', scopes: ['relay:connect'], ttlMs: 60_000 });
  await resets.begin({
    sessionJti: issued.payload.jti,
    deviceId: device.deviceId,
    accountId: ownerA.accountId,
    authorityGeneration: firstMembership.authorityGeneration
  });
  await accounts.removeDevice(ownerA.accountId, device.deviceId, 'supersede reset generation');
  const rebound = await accounts.bindDevice(ownerB.accountId, device.deviceId);
  assert.ok(rebound.authorityGeneration > firstMembership.authorityGeneration);
  const service = new RelayResultService({ stateDir: authorityState, identity: authorityIdentity, devices, sessions, accounts, resets });
  cleanupAfter(t, service);
  const { port } = await service.listen('127.0.0.1', 0);
  const response = await fetch(`http://127.0.0.1:${port}/v1/device-self/reset`, {
    method: 'POST', headers: { authorization: `Bearer ${issued.token}` }
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json() as any).error.code, 'DEVICE_RESET_SUPERSEDED');
  assert.equal(await accounts.ownsDevice(ownerB.accountId, device.deviceId), true);
  assert.equal((await devices.listDevices()).find((candidate) => candidate.deviceId === device.deviceId)?.status, 'active');
});


test('late authenticated result binds to an expired idempotent tombstone and becomes replayable', async (t) => {
  const authorityState = await tempDir(t, 'operator-late-result-authority-');
  const deviceState = await tempDir(t, 'operator-late-result-device-');
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  const devices = new DeviceRegistryStore(authorityState);
  const device = await pairDevice(authorityIdentity, devices, deviceIdentity);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices);
  const accounts = new AccountDeviceRegistry(authorityState, devices);
  const owner = await accounts.resolveOrCreateAccount({ issuer: 'test', subject: 'late-result-owner' });
  const membership = await accounts.bindDevice(owner.accountId, device.deviceId);
  const authority = { accountId: owner.accountId, deviceId: device.deviceId, generation: membership.authorityGeneration };
  let deliveryNow = Date.parse('2026-09-14T12:00:00.000Z');
  const deliveries = new RelayDeliveryStore(authorityState, { clock: () => new Date(deliveryNow), retentionMs: 60_000 });
  const results = new RelayResultStore(authorityState);
  const key = 'd'.repeat(64);
  const delivery = await deliveries.enqueue(device.deviceId, 'action', { action: { id: 'late' } }, authority, key);
  deliveryNow += 60_001;

  const service = new RelayResultService({ stateDir: authorityState, identity: authorityIdentity, devices, sessions, accounts, deliveries, results });
  cleanupAfter(t, service);
  const { port } = await service.listen('127.0.0.1', 0);
  const token = (await sessions.issue({ subjectDeviceId: device.deviceId, audience: 'operator-relay', scopes: ['relay:connect', 'relay:result'], ttlMs: 60_000 })).token;
  const response = await fetch(`http://127.0.0.1:${port}/v1/device-result`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ seq: delivery.seq, deliveryId: delivery.id, result: { ok: true, output: { value: 'late' } } })
  });
  assert.equal(response.status, 200, await response.text());
  const replay = await results.findByIdempotencyKey(key);
  assert.equal(replay?.result.result?.output?.value, 'late');
  assert.deepEqual(replay?.result.replayAuthority, authority);
});


test('result persistence is fenced against concurrent account-device release', async (t) => {
  const authorityState = await tempDir(t, 'operator-result-release-race-authority-');
  const deviceState = await tempDir(t, 'operator-result-release-race-device-');
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  const devices = new DeviceRegistryStore(authorityState);
  const device = await pairDevice(authorityIdentity, devices, deviceIdentity);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices);
  const deliveries = new RelayDeliveryStore(authorityState);
  const results = new RelayResultStore(authorityState);
  let releasePurged!: () => void; const purged = new Promise<void>((resolve) => { releasePurged = resolve; });
  let finishRelease!: () => void; const releaseGate = new Promise<void>((resolve) => { finishRelease = resolve; });
  const accounts = new AccountDeviceRegistry(authorityState, devices, { onReleaseDevice: async (deviceId) => {
    await deliveries.purgeDevice(deviceId); await results.purgeDevice(deviceId); await sessions.purgeForDevice(deviceId);
    releasePurged(); await releaseGate;
  } });
  const owner = await accounts.resolveOrCreateAccount({ issuer: 'test', subject: 'release-race-owner' });
  const membership = await accounts.bindDevice(owner.accountId, device.deviceId);
  const authority = { accountId: owner.accountId, deviceId: device.deviceId, generation: membership.authorityGeneration };
  const key = 'e'.repeat(64);
  const delivery = await deliveries.enqueue(device.deviceId, 'action', { action: { id: 'race' } }, authority, key);
  const token = (await sessions.issue({ subjectDeviceId: device.deviceId, audience: 'operator-relay', scopes: ['relay:connect', 'relay:result'], ttlMs: 60_000 })).token;
  const originalPut = results.put.bind(results);
  let removing: Promise<unknown> | null = null;
  (results as any).put = async (...args: any[]) => {
    removing ??= accounts.removeDevice(owner.accountId, device.deviceId, 'release race');
    await purged;
    return await (originalPut as any)(...args);
  };
  const service = new RelayResultService({ stateDir: authorityState, identity: authorityIdentity, devices, sessions, accounts, deliveries, results });
  cleanupAfter(t, service);
  const { port } = await service.listen('127.0.0.1', 0);
  const response = await fetch(`http://127.0.0.1:${port}/v1/device-result`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ seq: delivery.seq, deliveryId: delivery.id, result: { ok: true, output: { value: 'stale' } } })
  });
  const body = await response.json() as any;
  finishRelease();
  await removing;
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'RELAY_RESULT_AUTHORITY_REVOKED');
  assert.equal(await results.get(device.deviceId, delivery.seq), null);
  assert.equal(await results.findByIdempotencyKey(key), null);
});
