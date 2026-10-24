import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccountDeviceRegistry } from '../../../src/core/account-device-registry.ts';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { DeviceRegistryStore, answerPairingChallenge } from '../../../src/core/device-registry.ts';
import { RelayDeliveryStore } from '../../../src/core/relay-delivery-store.ts';
import { DeviceSessionTokenStore } from '../../../src/core/session-token.ts';
import { RelayResultService } from '../src/result-service.ts';

test('authenticated next-record status is read-only, redacted and cannot grant ACK, retry or cross-generation inspection', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-original-status-server-'));
  const local = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-original-status-device-'));
  t.after(async () => {
    await fs.rm(state, { recursive: true, force: true });
    await fs.rm(local, { recursive: true, force: true });
  });
  const issuer = new DeviceIdentityStore(state, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(local, { platform: 'linux' });
  const registry = new DeviceRegistryStore(state);
  const serviceIdentity = await issuer.loadOrCreate('Synthetic');
  const device = await deviceIdentity.loadOrCreate('Original host');
  const challenge = await registry.issuePairingChallenge(serviceIdentity, { expectedPeerDeviceId: device.deviceId, ttlMs: 60_000 });
  await registry.completePairing(await answerPairingChallenge(challenge, deviceIdentity));
  const sessions = new DeviceSessionTokenStore(state, issuer, registry);
  const accounts = new AccountDeviceRegistry(state, registry);
  const account = await accounts.resolveOrCreateAccount({ issuer: 'fixture', subject: 'original-host-recovery-status' });
  const bound = await accounts.bindDevice(account.accountId, device.deviceId);
  const authority = { accountId:account.accountId, deviceId:device.deviceId, generation:bound.authorityGeneration };
  const queue = new RelayDeliveryStore(state);
  const action = {
    id:'synthetic-no-replay', risk:'write' as const, capability:'file.write',
    input:{ secret:'NEVER_EXPOSE_TEST_INPUT' }, provenance:{ kind:'chatgpt' as const }
  };
  const delivery = await queue.enqueue(device.deviceId, 'action',
    { action, approvalAuthority:authority },authority,undefined,['file.write']);
  const service = new RelayResultService({ stateDir:state, identity:issuer,
    devices:registry, sessions, accounts, deliveries:queue });
  t.after(() => service.close());
  const {port} = await service.listen('127.0.0.1', 0);
  const endpoint = `http://127.0.0.1:${port}/v1/device-recovery/status`;
  const authorized = (await sessions.issue({subjectDeviceId:device.deviceId,audience:'operator-relay',
    scopes:['relay:connect','relay:result'],ttlMs:60_000})).token;
  async function post(previousSeq:number, token=authorized) {
    const response = await fetch(endpoint, {method:'POST',
      headers:{'content-type':'application/json',authorization:'Bearer '+token},
      body:JSON.stringify({previousSeq})});
    return {status:response.status,body:await response.json() as any};
  }

  const retainedFile = path.join(state,'relay-deliveries.json');
  const before = await fs.readFile(retainedFile);
  const pending = await post(0);
  assert.equal(pending.status,200);
  assert.deepEqual(pending.body.observation, {
    lastAckedSeq:0,highestEnqueuedSeq:1,nextSequence:1,retainedState:'pending'
  });
  for (const key of ['snapshotOnly','executionAuthorized','replayAuthorized','acknowledgmentAuthorized']) {
    assert.equal(pending.body[key],key==='snapshotOnly');
  }
  assert.equal(JSON.stringify(pending.body).includes('NEVER_EXPOSE_TEST_INPUT'),false);
  assert.equal(JSON.stringify(pending.body).includes(delivery.id),false);
  assert.deepEqual(await fs.readFile(retainedFile),before,'status read must not mutate hosted durable queue');

  assert.equal((await post(0,'invalid')).status,401);
  assert.equal((await post(-1)).body.error.code,'RELAY_RECOVERY_INSPECT_SEQUENCE_INVALID');
  assert.equal((await post(1)).body.error.code,'RELAY_RECOVERY_INSPECT_CURSOR_MISMATCH');
  const weak = (await sessions.issue({subjectDeviceId:device.deviceId,audience:'operator-relay',
    scopes:['relay:connect'],ttlMs:60_000})).token;
  assert.equal((await post(0,weak)).status,401);

  // Synthetic hosted ACK generates an exact-cursor state with no next enqueued
  // record. The diagnostic status endpoint must report missing, not invent
  // a pending delivery or advance cursor itself.
  await queue.acknowledge(device.deviceId,delivery.seq,delivery.id);
  const acknowledgedBytes = await fs.readFile(retainedFile);
  const missing = await post(1);
  assert.equal(missing.status,200);
  assert.deepEqual(missing.body.observation,{
    lastAckedSeq:1,highestEnqueuedSeq:1,nextSequence:2,retainedState:'missing'
  });
  assert.deepEqual(await fs.readFile(retainedFile),acknowledgedBytes);

  // A-B-A account generation must not allow observation of pending metadata
  // from a prior generation, even through a newly issued valid device token.
  const next = await queue.enqueue(device.deviceId,'action',
    { action:{...action,id:'synthetic-stale-generation'},approvalAuthority:authority },
    authority,undefined,['file.write']);
  assert.equal(next.seq,2);
  await accounts.removeDevice(account.accountId,device.deviceId,'test authorization fence');
  const rebound = await accounts.bindDevice(account.accountId,device.deviceId);
  assert.notEqual(rebound.authorityGeneration,authority.generation);
  const newToken = (await sessions.issue({subjectDeviceId:device.deviceId,audience:'operator-relay',
    scopes:['relay:connect','relay:result'],ttlMs:60_000})).token;
  const revoked = await post(1,newToken);
  assert.notEqual(revoked.status,200);
  assert.equal(revoked.body.error.code,'RELAY_RECOVERY_INSPECT_AUTHORITY_REVOKED');
  assert.equal(JSON.stringify(revoked.body).includes('synthetic-stale-generation'),false);
  assert.equal(JSON.stringify(revoked.body).includes('NEVER_EXPOSE_TEST_INPUT'),false);
});

test('both public edge configurations expose the authenticated recovery-status route', async () => {
  for (const config of ['Caddyfile.example', 'Caddyfile.shared-vps-internal.example']) {
    const file = new URL('../../../deploy/public-edge/' + config, import.meta.url);
    const text = await fs.readFile(file, 'utf8');
    const deviceMatcher = text.split('\n').find(line => line.includes('@device_api path'));
    assert.ok(deviceMatcher?.includes('/v1/device-recovery/inspect') &&
      deviceMatcher.includes('/v1/device-recovery/status'),
      config + ' must explicitly route both recovery APIs to the device service');
  }
});
