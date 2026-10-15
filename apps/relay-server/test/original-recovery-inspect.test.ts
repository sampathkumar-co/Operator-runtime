import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccountDeviceRegistry } from '../../../src/core/account-device-registry.ts';
import { actionHash } from '../../../src/core/action-identity.ts';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { DeviceRegistryStore, answerPairingChallenge } from '../../../src/core/device-registry.ts';
import { RelayDeliveryStore } from '../../../src/core/relay-delivery-store.ts';
import { DeviceSessionTokenStore } from '../../../src/core/session-token.ts';
import { RelayResultService } from '../src/result-service.ts';

test('original host inspects exact next pending hosted identity without execution, result, ACK or input disclosure', async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-hosted-recovery-inspect-'));
  const deviceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-hosted-inspect-device-'));
  t.after(async () => { await fs.rm(deviceRoot, { recursive: true, force: true }); await fs.rm(state, { recursive: true, force: true }); });
  const identity = new DeviceIdentityStore(state, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceRoot, { platform: 'linux' });
  const devices = new DeviceRegistryStore(state);
  const issuer = await identity.loadOrCreate('Synthetic Authority');
  const device = await deviceIdentity.loadOrCreate('Authorized Device');
  const challenge = await devices.issuePairingChallenge(issuer, { expectedPeerDeviceId: device.deviceId, ttlMs: 60_000 });
  await devices.completePairing(await answerPairingChallenge(challenge, deviceIdentity));

  const sessions = new DeviceSessionTokenStore(state, identity, devices);
  const accounts = new AccountDeviceRegistry(state, devices);
  const acct = await accounts.resolveOrCreateAccount({ issuer: 'test', subject: 'hosted-readonly-proof' });
  const membership = await accounts.bindDevice(acct.accountId, device.deviceId);
  const authority = { accountId: acct.accountId, deviceId: device.deviceId, generation: membership.authorityGeneration };
  const queue = new RelayDeliveryStore(state);
  const action = {
    id: 'mcp-inspection-fixture',
    risk: 'write' as const,
    capability: 'file.write',
    input: { path: '/not-a-real-user-secret', content: 'PRIVATE_PAYLOAD_DO_NOT_ECHO' },
    provenance: { kind: 'chatgpt' as const }
  };
  const delivery = await queue.enqueue(device.deviceId, 'action',
    { action, approvalAuthority: authority }, authority, undefined, ['file.write']);
  const original = await fs.readFile(path.join(state, 'relay-deliveries.json'));
  const service = new RelayResultService({ stateDir: state, identity, devices, sessions, accounts, deliveries: queue });
  t.after(() => service.close());
  const { port } = await service.listen('127.0.0.1', 0);
  const url = `http://127.0.0.1:${port}/v1/device-recovery/inspect`;
  const authorized = (await sessions.issue({
    subjectDeviceId: device.deviceId, audience: 'operator-relay',
    scopes: ['relay:connect', 'relay:result'], ttlMs: 60_000
  })).token;
  const invoke = async (payload: object, token = authorized) => {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload)
    });
    return { status: response.status, body: await response.json() as any };
  };
  const result = await invoke({ previousSeq: 0 });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.observation, {
    seq: delivery.seq, deliveryId: delivery.id, kind: 'action',
    authority,
    action: { id: action.id, risk: action.risk, capability: action.capability, hash: actionHash(action) }
  });
  assert.equal(result.body.snapshotOnly, true);
  assert.equal(result.body.executionAuthorized, false);
  assert.equal(result.body.replayAuthorized, false);
  assert.equal(result.body.acknowledgmentAuthorized, false);
  assert.equal(JSON.stringify(result.body).includes('PRIVATE_PAYLOAD_DO_NOT_ECHO'), false);
  assert.deepEqual(await fs.readFile(path.join(state, 'relay-deliveries.json')), original,
    'inspection must not touch the hosted durable delivery store');
  assert.deepEqual(await queue.cursor(device.deviceId), { lastAckedSeq: 0, highestEnqueuedSeq: 1 });

  assert.equal((await invoke({ previousSeq: 1 })).body.error.code, 'RELAY_RECOVERY_INSPECT_CURSOR_MISMATCH');
  assert.equal((await invoke({ previousSeq: -1 })).body.error.code, 'RELAY_RECOVERY_INSPECT_SEQUENCE_INVALID');
  const weakToken = (await sessions.issue({
    subjectDeviceId: device.deviceId, audience: 'operator-relay',
    scopes: ['relay:connect'], ttlMs: 60_000
  })).token;
  assert.equal((await invoke({ previousSeq: 0 }, weakToken)).status, 401);
  assert.equal((await invoke({ previousSeq: 0 }, 'invalid')).status, 401);

  await accounts.removeDevice(acct.accountId, device.deviceId, 'synthetic session revocation');
  const revoked = await invoke({ previousSeq: 0 });
  assert.notEqual(revoked.status, 200);
  assert.equal(JSON.stringify(revoked.body).includes(delivery.id), false);
});
