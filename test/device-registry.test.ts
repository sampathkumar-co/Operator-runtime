import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { DeviceRegistryStore, answerPairingChallenge } from '../src/core/device-registry.ts';

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: any) => error?.code === code);
}

function tamperSignature(signature: string): string {
  const bytes = Buffer.from(signature, 'base64url');
  assert.ok(bytes.length > 0);
  bytes[0] ^= 0x01;
  return bytes.toString('base64url');
}

test('two independent Ed25519 identities pair once and registry persists public material only', async (t) => {
  const issuerDir = await tempDir(t, 'operator-pair-issuer-');
  const peerDir = await tempDir(t, 'operator-pair-peer-');
  const registryDir = await tempDir(t, 'operator-pair-registry-');
  const issuerStore = new DeviceIdentityStore(issuerDir);
  const peerStore = new DeviceIdentityStore(peerDir);
  const issuer = await issuerStore.loadOrCreate('Issuer PC');
  const peer = await peerStore.loadOrCreate('Peer PC');
  const registry = new DeviceRegistryStore(registryDir);

  const challenge = await registry.issuePairingChallenge(issuer, { expectedPeerDeviceId: peer.deviceId, ttlMs: 60_000 });
  const response = await answerPairingChallenge(challenge, peerStore);
  const registered = await registry.completePairing(response);
  assert.equal(registered.deviceId, peer.deviceId);
  assert.equal(registered.fingerprint, peer.fingerprint);
  assert.equal(registered.status, 'active');
  assert.deepEqual((await new DeviceRegistryStore(registryDir).listDevices()).map((device) => device.deviceId), [peer.deviceId]);

  const persisted = await fs.readFile(path.join(registryDir, 'device-registry.json'), 'utf8');
  assert.match(persisted, /BEGIN PUBLIC KEY/);
  assert.doesNotMatch(persisted, /PRIVATE KEY/);
  assert.doesNotMatch(persisted, /privateKey/i);
});

test('pairing rejects tampered signatures, expires challenges, and rejects replay after successful consume', async (t) => {
  const issuerDir = await tempDir(t, 'operator-pair-security-issuer-');
  const peerDir = await tempDir(t, 'operator-pair-security-peer-');
  const registryDir = await tempDir(t, 'operator-pair-security-registry-');
  let now = new Date('2026-09-09T12:00:00.000Z');
  const clock = () => new Date(now);
  const issuerStore = new DeviceIdentityStore(issuerDir);
  const peerStore = new DeviceIdentityStore(peerDir);
  const issuer = await issuerStore.loadOrCreate('Issuer');
  const peer = await peerStore.loadOrCreate('Peer');
  const registry = new DeviceRegistryStore(registryDir, { clock });

  const challenge = await registry.issuePairingChallenge(issuer, { expectedPeerDeviceId: peer.deviceId, ttlMs: 30_000 });
  const valid = await answerPairingChallenge(challenge, peerStore);
  const tampered = { ...valid, signature: tamperSignature(valid.signature) };
  await expectCode(registry.completePairing(tampered), 'PAIRING_SIGNATURE_INVALID');
  assert.equal((await registry.listDevices()).length, 0);

  now = new Date('2026-09-09T12:00:31.000Z');
  await expectCode(registry.completePairing(valid), 'PAIRING_CHALLENGE_EXPIRED');

  now = new Date('2026-09-09T12:01:00.000Z');
  const fresh = await registry.issuePairingChallenge(issuer, { expectedPeerDeviceId: peer.deviceId, ttlMs: 60_000 });
  const freshResponse = await answerPairingChallenge(fresh, peerStore);
  await registry.completePairing(freshResponse);
  await expectCode(registry.completePairing(freshResponse), 'PAIRING_CHALLENGE_REPLAY');
});

test('expected peer binding rejects a different device before pairing', async (t) => {
  const issuerDir = await tempDir(t, 'operator-peer-bind-issuer-');
  const expectedDir = await tempDir(t, 'operator-peer-bind-expected-');
  const attackerDir = await tempDir(t, 'operator-peer-bind-attacker-');
  const registryDir = await tempDir(t, 'operator-peer-bind-registry-');
  const issuerStore = new DeviceIdentityStore(issuerDir);
  const expectedStore = new DeviceIdentityStore(expectedDir);
  const attackerStore = new DeviceIdentityStore(attackerDir);
  const issuer = await issuerStore.loadOrCreate('Issuer');
  const expected = await expectedStore.loadOrCreate('Expected');
  const registry = new DeviceRegistryStore(registryDir);
  const challenge = await registry.issuePairingChallenge(issuer, { expectedPeerDeviceId: expected.deviceId });
  await expectCode(answerPairingChallenge(challenge, attackerStore), 'PAIRING_PEER_MISMATCH');
  assert.equal((await registry.listDevices()).length, 0);
});

test('device ID cannot be rebound to a different Ed25519 key', async (t) => {
  const issuerDir = await tempDir(t, 'operator-conflict-issuer-');
  const firstDir = await tempDir(t, 'operator-conflict-first-');
  const secondDir = await tempDir(t, 'operator-conflict-second-');
  const registryDir = await tempDir(t, 'operator-conflict-registry-');
  const issuerStore = new DeviceIdentityStore(issuerDir);
  const firstStore = new DeviceIdentityStore(firstDir);
  const secondStore = new DeviceIdentityStore(secondDir);
  const issuer = await issuerStore.loadOrCreate('Issuer');
  const first = await firstStore.loadOrCreate('First');
  await secondStore.loadOrCreate('Second');
  const registry = new DeviceRegistryStore(registryDir);

  const firstChallenge = await registry.issuePairingChallenge(issuer, { expectedPeerDeviceId: first.deviceId });
  await registry.completePairing(await answerPairingChallenge(firstChallenge, firstStore));

  const secondIdentityPath = path.join(secondDir, 'device-identity.json');
  const secondStored = JSON.parse(await fs.readFile(secondIdentityPath, 'utf8'));
  secondStored.deviceId = first.deviceId;
  await fs.writeFile(secondIdentityPath, JSON.stringify(secondStored, null, 2));
  const conflictStore = new DeviceIdentityStore(secondDir);
  const challenge = await registry.issuePairingChallenge(issuer, { expectedPeerDeviceId: first.deviceId });
  const response = await answerPairingChallenge(challenge, conflictStore);
  await expectCode(registry.completePairing(response), 'DEVICE_IDENTITY_CONFLICT');
  assert.equal((await registry.listDevices()).length, 1);
  assert.equal((await registry.listDevices())[0].fingerprint, first.fingerprint);
});

test('revocation blocks subsequent signature authentication and cannot be silently undone by pairing', async (t) => {
  const issuerDir = await tempDir(t, 'operator-revoke-issuer-');
  const peerDir = await tempDir(t, 'operator-revoke-peer-');
  const registryDir = await tempDir(t, 'operator-revoke-registry-');
  const issuerStore = new DeviceIdentityStore(issuerDir);
  const peerStore = new DeviceIdentityStore(peerDir);
  const issuer = await issuerStore.loadOrCreate('Issuer');
  const peer = await peerStore.loadOrCreate('Peer');
  const registry = new DeviceRegistryStore(registryDir);
  const challenge = await registry.issuePairingChallenge(issuer, { expectedPeerDeviceId: peer.deviceId });
  await registry.completePairing(await answerPairingChallenge(challenge, peerStore));

  const payload = Buffer.from('authenticated-relay-frame');
  const signature = await peerStore.sign(payload);
  assert.equal(await registry.verifyDeviceSignature(peer.deviceId, payload, signature), true);
  const revoked = await registry.revokeDevice(peer.deviceId, 'user revoked device');
  assert.equal(revoked.status, 'revoked');
  await expectCode(registry.verifyDeviceSignature(peer.deviceId, payload, signature), 'DEVICE_REVOKED');

  const rePair = await registry.issuePairingChallenge(issuer, { expectedPeerDeviceId: peer.deviceId });
  await expectCode(registry.completePairing(await answerPairingChallenge(rePair, peerStore)), 'DEVICE_REVOKED');
});
