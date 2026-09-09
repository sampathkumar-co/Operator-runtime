import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { DeviceRegistryStore, answerPairingChallenge } from '../src/core/device-registry.ts';
import { DeviceSessionTokenStore } from '../src/core/session-token.ts';

type Device = {
  state: string;
  identity: DeviceIdentityStore;
  registry: DeviceRegistryStore;
};

async function device(prefix: string, name: string, clock?: () => Date): Promise<Device> {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const identity = new DeviceIdentityStore(state);
  await identity.loadOrCreate(name);
  return { state, identity, registry: new DeviceRegistryStore(state, clock ? { clock } : {}) };
}

async function pair(issuer: Device, peer: Device, ttlMs = 60_000): Promise<void> {
  const issuerPublic = await issuer.identity.loadOrCreate();
  const peerPublic = await peer.identity.loadOrCreate();
  const challenge = await issuer.registry.issuePairingChallenge(issuerPublic, {
    expectedPeerDeviceId: peerPublic.deviceId,
    ttlMs
  });
  const response = await answerPairingChallenge(challenge, peer.identity);
  await issuer.registry.completePairing(response);
}

async function pairBoth(a: Device, b: Device): Promise<void> {
  await pair(a, b);
  await pair(b, a);
}

function tamperSignature(signature: string): string {
  const bytes = Buffer.from(signature, 'base64url');
  assert.ok(bytes.length > 0);
  bytes[0] ^= 0x01;
  return bytes.toString('base64url');
}

test('device session token is audience/scope/subject bound and verifiable by the paired peer', async (t) => {
  const a = await device('operator-session-a-', 'A');
  const b = await device('operator-session-b-', 'B');
  t.after(() => Promise.all([fs.rm(a.state, { recursive: true, force: true }), fs.rm(b.state, { recursive: true, force: true })]));
  await pairBoth(a, b);

  const bPublic = await b.identity.loadOrCreate();
  const aSessions = new DeviceSessionTokenStore(a.state, a.identity, a.registry);
  const bSessions = new DeviceSessionTokenStore(b.state, b.identity, b.registry);
  const issued = await aSessions.issue({
    subjectDeviceId: bPublic.deviceId,
    audience: 'operator-relay',
    scopes: ['action:read', 'task:resume'],
    ttlMs: 60_000
  });

  const local = await aSessions.verify(issued.token, {
    audience: 'operator-relay',
    requiredScopes: ['action:read'],
    expectedSubjectDeviceId: bPublic.deviceId
  });
  assert.equal(local.jti, issued.payload.jti);

  const remote = await bSessions.verify(issued.token, {
    audience: 'operator-relay',
    requiredScopes: ['task:resume'],
    expectedSubjectDeviceId: bPublic.deviceId
  });
  assert.equal(remote.issuerDeviceId, (await a.identity.loadOrCreate()).deviceId);

  await assert.rejects(
    bSessions.verify(issued.token, { audience: 'wrong-relay' }),
    (error: any) => error?.code === 'SESSION_AUDIENCE_MISMATCH'
  );
  await assert.rejects(
    bSessions.verify(issued.token, { audience: 'operator-relay', requiredScopes: ['action:write'] }),
    (error: any) => error?.code === 'SESSION_SCOPE_DENIED'
  );
  await assert.rejects(
    bSessions.verify(issued.token, { audience: 'operator-relay', expectedSubjectDeviceId: (await a.identity.loadOrCreate()).deviceId }),
    (error: any) => error?.code === 'SESSION_SUBJECT_MISMATCH'
  );
});

test('session token rejects signature/payload tampering and expires under a bounded clock', async (t) => {
  let nowMs = Date.parse('2026-09-09T12:00:00.000Z');
  const clock = () => new Date(nowMs);
  const a = await device('operator-session-exp-a-', 'A', clock);
  const b = await device('operator-session-exp-b-', 'B', clock);
  t.after(() => Promise.all([fs.rm(a.state, { recursive: true, force: true }), fs.rm(b.state, { recursive: true, force: true })]));
  await pairBoth(a, b);

  const bPublic = await b.identity.loadOrCreate();
  const aSessions = new DeviceSessionTokenStore(a.state, a.identity, a.registry, { clock });
  const bSessions = new DeviceSessionTokenStore(b.state, b.identity, b.registry, { clock });
  const issued = await aSessions.issue({ subjectDeviceId: bPublic.deviceId, audience: 'relay', scopes: ['read'], ttlMs: 30_000 });

  const [payloadPart, signaturePart] = issued.token.split('.');
  const tamperedSignature = tamperSignature(signaturePart!);
  await assert.rejects(
    bSessions.verify(`${payloadPart}.${tamperedSignature}`, { audience: 'relay' }),
    (error: any) => error?.code === 'SESSION_SIGNATURE_INVALID'
  );

  const payload = JSON.parse(Buffer.from(payloadPart!, 'base64url').toString('utf8'));
  payload.audience = 'evil';
  const tamperedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  await assert.rejects(
    bSessions.verify(`${tamperedPayload}.${signaturePart}`, { audience: 'evil' }),
    (error: any) => ['SESSION_TOKEN_INVALID', 'SESSION_SIGNATURE_INVALID'].includes(error?.code)
  );

  nowMs += 30_001;
  await assert.rejects(
    aSessions.verify(issued.token, { audience: 'relay' }),
    (error: any) => error?.code === 'SESSION_EXPIRED'
  );
});

test('rotation atomically revokes the old jti and activates exactly one replacement', async (t) => {
  const a = await device('operator-session-rotate-a-', 'A');
  const b = await device('operator-session-rotate-b-', 'B');
  t.after(() => Promise.all([fs.rm(a.state, { recursive: true, force: true }), fs.rm(b.state, { recursive: true, force: true })]));
  await pairBoth(a, b);

  const bPublic = await b.identity.loadOrCreate();
  const sessions = new DeviceSessionTokenStore(a.state, a.identity, a.registry);
  const first = await sessions.issue({ subjectDeviceId: bPublic.deviceId, audience: 'relay', scopes: ['read'], ttlMs: 60_000 });
  const replacement = await sessions.rotate(first.payload.jti, { ttlMs: 60_000 });

  assert.notEqual(replacement.payload.jti, first.payload.jti);
  const records = await sessions.listIssued(10);
  const old = records.find((record) => record.jti === first.payload.jti);
  const next = records.find((record) => record.jti === replacement.payload.jti);
  assert.equal(old?.status, 'revoked');
  assert.equal(old?.revokedReason, `rotated:${replacement.payload.jti}`);
  assert.equal(next?.status, 'active');
  assert.equal(records.filter((record) => record.status === 'active').length, 1);

  await assert.rejects(
    sessions.verify(first.token, { audience: 'relay' }),
    (error: any) => error?.code === 'SESSION_REVOKED'
  );
  assert.equal((await sessions.verify(replacement.token, { audience: 'relay' })).jti, replacement.payload.jti);

  const persisted = await fs.readFile(path.join(a.state, 'device-sessions.json'), 'utf8');
  assert.equal(persisted.includes(first.token), false);
  assert.equal(persisted.includes(replacement.token), false);
  assert.equal(/PRIVATE KEY/.test(persisted), false);
});

test('issuer-side revocation is immediate and revoked devices cannot receive or verify new local sessions', async (t) => {
  const a = await device('operator-session-revoke-a-', 'A');
  const b = await device('operator-session-revoke-b-', 'B');
  t.after(() => Promise.all([fs.rm(a.state, { recursive: true, force: true }), fs.rm(b.state, { recursive: true, force: true })]));
  await pairBoth(a, b);

  const bPublic = await b.identity.loadOrCreate();
  const aSessions = new DeviceSessionTokenStore(a.state, a.identity, a.registry);
  const issued = await aSessions.issue({ subjectDeviceId: bPublic.deviceId, audience: 'relay', scopes: ['read'], ttlMs: 60_000 });
  await aSessions.revoke(issued.payload.jti, 'operator-disconnect');
  await assert.rejects(
    aSessions.verify(issued.token, { audience: 'relay' }),
    (error: any) => error?.code === 'SESSION_REVOKED'
  );

  await a.registry.revokeDevice(bPublic.deviceId, 'device removed');
  await assert.rejects(
    aSessions.issue({ subjectDeviceId: bPublic.deviceId, audience: 'relay', scopes: ['read'], ttlMs: 60_000 }),
    (error: any) => error?.code === 'DEVICE_REVOKED'
  );
});
