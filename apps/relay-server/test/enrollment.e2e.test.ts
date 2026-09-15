import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccountDeviceRegistry } from '../../../src/core/account-device-registry.ts';
import { DeviceEnrollmentStore, enrollmentPollBinding } from '../../../src/core/device-enrollment.ts';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { DeviceRegistryStore, answerPairingChallenge } from '../../../src/core/device-registry.ts';
import { PUBLIC_PLUGIN_CAPABILITIES } from '../../../src/core/public-plugin-surface.ts';
import { DeviceSessionTokenStore } from '../../../src/core/session-token.ts';
import { RelayControlService } from '../src/control-service.ts';
import { RelayResultService } from '../src/result-service.ts';
import { LocalDeviceResetCoordinator } from '../../local-agent/src/device-reset.ts';

const CONTROL_TOKEN = 'relay-control-token-enrollment-0123456789abcdef';

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function postJson(url: string, body: unknown, token?: string) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json() as any;
  return { response, payload };
}

test('fresh device enrollment binds authenticated account and returns one recoverable short-lived session without persisting bootstrap secrets', async (t) => {
  const authorityState = await tempDir(t, 'operator-enrollment-authority-');
  const deviceState = await tempDir(t, 'operator-enrollment-device-');
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  const devices = new DeviceRegistryStore(authorityState);
  const enrollments = new DeviceEnrollmentStore(authorityState);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices);
  const accounts = new AccountDeviceRegistry(authorityState, devices, {
    onReleaseDevice: async (deviceId) => {
      await sessions.purgeForDevice(deviceId);
      await enrollments.purgeDevice(deviceId);
    }
  });
  const resultService = new RelayResultService({
    stateDir: authorityState,
    identity: authorityIdentity,
    devices,
    sessions,
    accounts,
    enrollments
  });
  const controlService = new RelayControlService({
    hub: { dispatch: async () => { throw new Error('must not dispatch during enrollment'); } } as any,
    results: { consume: async () => null } as any,
    accounts,
    enrollments,
    devices,
    token: CONTROL_TOKEN
  });
  const resultListening = await resultService.listen('127.0.0.1', 0);
  const controlListening = await controlService.listen('127.0.0.1', 0);
  t.after(async () => {
    await Promise.allSettled([controlService.close(), resultService.close()]);
  });

  const device = await deviceIdentity.loadOrCreate('Fresh Device');
  const resultBase = `http://127.0.0.1:${resultListening.port}`;
  const controlBase = `http://127.0.0.1:${controlListening.port}`;
  const challenged = await postJson(`${resultBase}/v1/device-enrollment/challenge`, { deviceId: device.deviceId });
  assert.equal(challenged.response.status, 200, JSON.stringify(challenged.payload));
  const challenge = challenged.payload.challenge;
  assert.equal(challenge.expectedPeerDeviceId, device.deviceId);
  const pairing = await answerPairingChallenge(challenge, deviceIdentity);
  const pollToken = crypto.randomBytes(32).toString('base64url');
  const pollSignature = await deviceIdentity.sign(
    enrollmentPollBinding(pairing.challengeId, device.deviceId, pollToken)
  );
  const completed = await postJson(`${resultBase}/v1/device-enrollment/complete`, {
    pairingResponse: pairing,
    pollToken,
    pollSignature
  });
  assert.equal(completed.response.status, 200, JSON.stringify(completed.payload));
  assert.equal(completed.payload.enrollment.deviceId, device.deviceId);
  assert.equal(completed.payload.enrollment.enrollmentId, pairing.challengeId);
  assert.equal((await devices.listDevices()).length, 0, 'unauthenticated enrollment completion must remain provisional');
  const userCode = String(completed.payload.enrollment.userCode);
  assert.match(userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const enrollmentFile = await fs.readFile(path.join(authorityState, 'device-enrollments.json'), 'utf8');
  assert.equal(enrollmentFile.includes(pollToken), false);
  assert.equal(enrollmentFile.includes(userCode), false);
  assert.equal(enrollmentFile.includes(userCode.replace('-', '')), false);

  const pending = await postJson(`${resultBase}/v1/device-enrollment/poll`, {
    enrollmentId: pairing.challengeId,
    pollToken
  });
  assert.equal(pending.response.status, 202, JSON.stringify(pending.payload));
  assert.equal(pending.payload.enrollment.status, 'pending');
  const principal = { issuer: 'https://issuer.operator-runtime.dev', subject: 'enrollment-user' };
  const claimed = await postJson(`${controlBase}/v1/device-enrollment/claim`, {
    principal,
    userCode
  }, CONTROL_TOKEN);
  assert.equal(claimed.response.status, 200, JSON.stringify(claimed.payload));
  assert.equal(claimed.payload.enrollment.status, 'claimed');
  assert.equal((await devices.listDevices()).filter((entry) => entry.status === 'active').length, 1);

  const issued = await postJson(`${resultBase}/v1/device-enrollment/poll`, {
    enrollmentId: pairing.challengeId,
    pollToken
  });
  assert.equal(issued.response.status, 200, JSON.stringify(issued.payload));
  assert.equal(issued.payload.enrollment.status, 'issued');
  assert.equal(typeof issued.payload.session.token, 'string');
  assert.equal(issued.payload.session.token.includes(pollToken), false);
  assert.deepEqual(
    [...issued.payload.session.scopes].sort(),
    ['relay:connect', 'relay:result', ...PUBLIC_PLUGIN_CAPABILITIES.map((capability) => `cap:${capability}`)].sort()
  );

  const verified = await sessions.verify(issued.payload.session.token, {
    audience: 'operator-relay',
    requiredScopes: ['relay:connect', 'relay:result'],
    expectedSubjectDeviceId: device.deviceId
  });
  assert.equal(verified.jti, pairing.challengeId);
  assert.equal(verified.subjectDeviceId, device.deviceId);
  const retry = await postJson(`${resultBase}/v1/device-enrollment/poll`, {
    enrollmentId: pairing.challengeId,
    pollToken
  });
  assert.equal(retry.response.status, 200, JSON.stringify(retry.payload));
  assert.equal(retry.payload.session.token, issued.payload.session.token);
  const records = await sessions.listIssued(20);
  assert.equal(records.filter((record) => record.jti === pairing.challengeId).length, 1);

  const account = await accounts.resolveOrCreateAccount(principal);
  const membership = await accounts.activeMembershipForDevice(device.deviceId);
  assert.equal(membership?.accountId, account.accountId);
  assert.equal(Number.isSafeInteger(membership?.authorityGeneration), true);

  await accounts.removeDevice(account.accountId, device.deviceId, 'user removed device');
  const afterRemoval = await postJson(`${resultBase}/v1/device-enrollment/poll`, {
    enrollmentId: pairing.challengeId,
    pollToken
  });
  assert.equal(afterRemoval.response.status, 400);
  assert.equal(afterRemoval.payload.error.code, 'DEVICE_ENROLLMENT_UNAUTHORIZED');
  await assert.rejects(
    sessions.verify(issued.payload.session.token, { audience: 'operator-relay' }),
    (error: any) => ['SESSION_NOT_FOUND', 'SESSION_REVOKED'].includes(error?.code)
  );
});


test('ownership transfer preserves the new reserved enrollment while prior authority is cleaned', async (t) => {
  const authorityState = await tempDir(t, 'operator-enrollment-transfer-authority-');
  const deviceState = await tempDir(t, 'operator-enrollment-transfer-device-');
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  const devices = new DeviceRegistryStore(authorityState);
  const enrollments = new DeviceEnrollmentStore(authorityState);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices);
  const accounts = new AccountDeviceRegistry(authorityState, devices, {
    onReleaseDevice: async (deviceId, accountId, reason) => {
      await sessions.purgeForDevice(deviceId);
      if (reason === 'rebind') await enrollments.purgeDeviceForAccount(deviceId, accountId);
      else await enrollments.purgeDevice(deviceId);
    }
  });
  const device = await deviceIdentity.loadOrCreate('Transfer Device');
  const authority = await authorityIdentity.loadOrCreate('Authority');
  const challenge = await devices.issuePairingChallenge(authority, { expectedPeerDeviceId: device.deviceId, ttlMs: 60_000 });
  const pairing = await answerPairingChallenge(challenge, deviceIdentity);
  await devices.completePairing(pairing);
  const ownerA = await accounts.resolveOrCreateAccount({ issuer: 'issuer', subject: 'transfer-a' });
  const ownerB = await accounts.resolveOrCreateAccount({ issuer: 'issuer', subject: 'transfer-b' });
  const first = await accounts.bindDevice(ownerA.accountId, device.deviceId);
  const oldEnrollment = await enrollments.create(device, { ttlMs: 60_000 });
  await enrollments.reserve(oldEnrollment.userCode, ownerA.accountId);
  await enrollments.markBound(oldEnrollment.enrollmentId, ownerA.accountId, first.authorityGeneration);
  await enrollments.markIssued(oldEnrollment.enrollmentId, oldEnrollment.pollToken, oldEnrollment.enrollmentId);
  await accounts.removeDevice(ownerA.accountId, device.deviceId, 'transfer');

  const current = await enrollments.create(device, { ttlMs: 60_000 });
  const reserved = await enrollments.reserve(current.userCode, ownerB.accountId);
  assert.equal(reserved.status, 'reserved');
  const rebound = await accounts.bindDevice(ownerB.accountId, device.deviceId);
  const claimed = await enrollments.markBound(current.enrollmentId, ownerB.accountId, rebound.authorityGeneration);
  assert.equal(claimed.status, 'claimed');
  await enrollments.markIssued(current.enrollmentId, current.pollToken, current.enrollmentId);
  assert.equal((await enrollments.poll(current.enrollmentId, current.pollToken)).accountId, ownerB.accountId);
  await assert.rejects(enrollments.poll(oldEnrollment.enrollmentId, oldEnrollment.pollToken), (error: any) => error?.code === 'DEVICE_ENROLLMENT_UNAUTHORIZED');

  await accounts.removeDevice(ownerB.accountId, device.deviceId, 'transfer back');
  const backToA = await enrollments.create(device, { ttlMs: 60_000 });
  await enrollments.reserve(backToA.userCode, ownerA.accountId);
  const reboundToA = await accounts.bindDevice(ownerA.accountId, device.deviceId);
  const claimedBackToA = await enrollments.markBound(backToA.enrollmentId, ownerA.accountId, reboundToA.authorityGeneration);
  assert.equal(claimedBackToA.status, 'claimed');
  await enrollments.markIssued(backToA.enrollmentId, backToA.pollToken, backToA.enrollmentId);

  await accounts.removeDevice(ownerA.accountId, device.deviceId, 'same-account reenroll');
  const sameAccount = await enrollments.create(device, { ttlMs: 60_000 });
  await enrollments.reserve(sameAccount.userCode, ownerA.accountId);
  const reboundSameAccount = await accounts.bindDevice(ownerA.accountId, device.deviceId);
  const claimedSameAccount = await enrollments.markBound(sameAccount.enrollmentId, ownerA.accountId, reboundSameAccount.authorityGeneration);
  assert.equal(claimedSameAccount.status, 'claimed');
  assert.equal((await enrollments.poll(sameAccount.enrollmentId, sameAccount.pollToken)).accountId, ownerA.accountId);
});

test('device reset forces a new cryptographic identity before fresh enrollment can regain authority', async (t) => {
  const authorityState = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-reset-reenroll-authority-'));
  const deviceState = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-reset-reenroll-device-'));
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  let deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  const devices = new DeviceRegistryStore(authorityState);
  const enrollments = new DeviceEnrollmentStore(authorityState);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices);
  const accounts = new AccountDeviceRegistry(authorityState, devices, {
    onReleaseDevice: async (deviceId) => {
      await sessions.purgeForDevice(deviceId);
      await enrollments.purgeDevice(deviceId);
    }
  });
  const resultService = new RelayResultService({ stateDir: authorityState, identity: authorityIdentity, devices, sessions, accounts, enrollments });
  const controlService = new RelayControlService({
    hub: { dispatch: async () => { throw new Error('must not dispatch during enrollment'); } } as any,
    results: { consume: async () => null } as any,
    accounts, enrollments, devices, token: CONTROL_TOKEN
  });
  const resultListening = await resultService.listen('127.0.0.1', 0);
  const controlListening = await controlService.listen('127.0.0.1', 0);
  const resultBase = `http://127.0.0.1:${resultListening.port}`;
  const controlBase = `http://127.0.0.1:${controlListening.port}`;
  const principal = { issuer: 'https://issuer.operator-runtime.dev', subject: 'reset-reenroll-user' };
  t.after(async () => {
    await Promise.allSettled([controlService.close(), resultService.close()]);
    await Promise.allSettled([
      fs.rm(authorityState, { recursive: true, force: true }),
      fs.rm(deviceState, { recursive: true, force: true })
    ]);
  });

  async function enroll(identity: DeviceIdentityStore) {
    const device = await identity.loadOrCreate('Resettable Device');
    const challenged = await postJson(`${resultBase}/v1/device-enrollment/challenge`, { deviceId: device.deviceId });
    assert.equal(challenged.response.status, 200, JSON.stringify(challenged.payload));
    const challenge = challenged.payload.challenge;
    const pairing = await answerPairingChallenge(challenge, identity);
    const pollToken = crypto.randomBytes(32).toString('base64url');
    const pollSignature = await identity.sign(enrollmentPollBinding(pairing.challengeId, device.deviceId, pollToken));
    const completed = await postJson(`${resultBase}/v1/device-enrollment/complete`, { pairingResponse: pairing, pollToken, pollSignature });
    assert.equal(completed.response.status, 200, JSON.stringify(completed.payload));
    const claimed = await postJson(`${controlBase}/v1/device-enrollment/claim`, { principal, userCode: completed.payload.enrollment.userCode }, CONTROL_TOKEN);
    assert.equal(claimed.response.status, 200, JSON.stringify(claimed.payload));
    const issued = await postJson(`${resultBase}/v1/device-enrollment/poll`, { enrollmentId: pairing.challengeId, pollToken });
    assert.equal(issued.response.status, 200, JSON.stringify(issued.payload));
    await sessions.verify(issued.payload.session.token, {
      audience: 'operator-relay',
      requiredScopes: ['relay:connect', 'relay:result'],
      expectedSubjectDeviceId: device.deviceId
    });
    return { device, token: issued.payload.session.token };
  }

  const first = await enroll(deviceIdentity);
  const account = await accounts.resolveOrCreateAccount(principal);
  const beforeMembership = await accounts.activeMembershipForDevice(first.device.deviceId);
  assert.equal(beforeMembership?.accountId, account.accountId);

  const reset = new LocalDeviceResetCoordinator({
    stateDir: deviceState,
    identity: deviceIdentity,
    resetUrl: `${resultBase}/v1/device-self/reset`,
    getResetToken: async () => first.token,
    stopRelay: async () => undefined
  });
  const resetResult = await reset.reset();
  assert.equal(resetResult.hostedStatus, 'revoked');
  assert.equal(resetResult.deviceId, first.device.deviceId);
  assert.equal(await deviceIdentity.loadExisting(), null);
  assert.equal(await accounts.activeMembershipForDevice(first.device.deviceId), null);
  const oldRegistered = (await devices.listDevices()).find((entry) => entry.deviceId === first.device.deviceId);
  assert.equal(oldRegistered?.status, 'revoked');
  await assert.rejects(
    sessions.verify(first.token, { audience: 'operator-relay' }),
    (error: any) => ['SESSION_NOT_FOUND', 'SESSION_REVOKED', 'DEVICE_REVOKED'].includes(error?.code)
  );

  deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  const replacementIdentity = await deviceIdentity.loadOrCreate('Resettable Device');
  assert.notEqual(replacementIdentity.deviceId, first.device.deviceId);
  assert.notEqual(replacementIdentity.publicKeyPem, first.device.publicKeyPem);

  const second = await enroll(deviceIdentity);
  assert.equal(second.device.deviceId, replacementIdentity.deviceId);
  const afterMembership = await accounts.activeMembershipForDevice(second.device.deviceId);
  assert.equal(afterMembership?.accountId, account.accountId);
  assert.equal((await devices.listDevices()).filter((entry) => entry.status === 'active').some((entry) => entry.deviceId === first.device.deviceId), false);
});

test('unauthenticated completed enrollments cannot exhaust permanent device or active challenge capacity', async (t) => {
  const authorityState = await tempDir(t, 'operator-enrollment-pressure-authority-');
  const deviceState = await tempDir(t, 'operator-enrollment-pressure-device-');
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  const devices = new DeviceRegistryStore(authorityState);
  const service = new RelayResultService({ stateDir: authorityState, identity: authorityIdentity, devices, requestLimitPerMinute: 1000 });
  const listening = await service.listen('127.0.0.1', 0);
  t.after(() => service.close());
  const base = `http://127.0.0.1:${listening.port}`;
  const device = await deviceIdentity.loadOrCreate('Pressure Device');

  for (let index = 0; index < 140; index += 1) {
    const challenged = await postJson(`${base}/v1/device-enrollment/challenge`, { deviceId: device.deviceId });
    assert.equal(challenged.response.status, 200, `challenge ${index}: ${JSON.stringify(challenged.payload)}`);
    const pairing = await answerPairingChallenge(challenged.payload.challenge, deviceIdentity);
    const pollToken = crypto.randomBytes(32).toString('base64url');
    const pollSignature = await deviceIdentity.sign(enrollmentPollBinding(pairing.challengeId, device.deviceId, pollToken));
    const completed = await postJson(`${base}/v1/device-enrollment/complete`, { pairingResponse: pairing, pollToken, pollSignature });
    assert.equal(completed.response.status, 200, `complete ${index}: ${JSON.stringify(completed.payload)}`);
  }

  assert.equal((await devices.listDevices()).length, 0);
});
