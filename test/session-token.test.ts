import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
  const identity = new DeviceIdentityStore(state, { platform: 'linux' });
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

test('default relay session lifetime is 30 minutes and longer sessions are rejected', async (t) => {
  const nowMs = Date.parse('2026-09-16T12:00:00.000Z');
  const clock = () => new Date(nowMs);
  const a = await device('operator-session-30m-a-', 'A', clock);
  const b = await device('operator-session-30m-b-', 'B', clock);
  t.after(() => Promise.all([fs.rm(a.state, { recursive: true, force: true }), fs.rm(b.state, { recursive: true, force: true })]));
  await pairBoth(a, b);

  const peer = await b.identity.loadOrCreate();
  const sessions = new DeviceSessionTokenStore(a.state, a.identity, a.registry, { clock });
  const issued = await sessions.issue({ subjectDeviceId: peer.deviceId, audience: 'operator-relay', scopes: ['relay:connect'] });
  assert.equal(Date.parse(issued.payload.expiresAt) - Date.parse(issued.payload.issuedAt), 30 * 60_000);

  const replacement = await sessions.rotate(issued.payload.jti);
  assert.notEqual(replacement.payload.jti, issued.payload.jti);
  assert.equal(Date.parse(replacement.payload.expiresAt) - Date.parse(replacement.payload.issuedAt), 30 * 60_000);

  await assert.rejects(
    sessions.issue({ subjectDeviceId: peer.deviceId, audience: 'operator-relay', scopes: ['relay:connect'], ttlMs: 30 * 60_000 + 1 }),
    (error: any) => error?.code === 'SESSION_TTL_INVALID'
  );
});

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

test('same-scope rotation preserves a bounded live-connection handoff without weakening fresh-token revocation', async (t) => {
  let nowMs = Date.parse('2026-10-02T12:00:00.000Z');
  const clock = () => new Date(nowMs);
  const a = await device('operator-session-handoff-a-', 'A', clock);
  const b = await device('operator-session-handoff-b-', 'B', clock);
  t.after(() => Promise.all([fs.rm(a.state, { recursive: true, force: true }), fs.rm(b.state, { recursive: true, force: true })]));
  await pairBoth(a, b);

  const peer = await b.identity.loadOrCreate();
  const revoked: string[] = [];
  const sessions = new DeviceSessionTokenStore(a.state, a.identity, a.registry, {
    clock,
    onRevoke: async (jti) => { revoked.push(jti); }
  });
  const first = await sessions.issue({
    subjectDeviceId: peer.deviceId,
    audience: 'operator-relay',
    scopes: ['relay:connect', 'cap:file.read'],
    ttlMs: 5 * 60_000
  });
  const replacement = await sessions.rotate(first.payload.jti, { ttlMs: 5 * 60_000 });

  assert.deepEqual(revoked, [], 'same-scope rotation must not kill the healthy transport');
  await assert.rejects(sessions.verify(first.token, { audience: 'operator-relay' }), (error: any) => error?.code === 'SESSION_REVOKED');
  assert.equal(await sessions.isConnectionContinuable(first.payload.jti, peer.deviceId), true);

  nowMs += 2 * 60_000 + 1;
  assert.equal(await sessions.isConnectionContinuable(first.payload.jti, peer.deviceId), false);

  const narrowed = await sessions.rotate(replacement.payload.jti, {
    ttlMs: 5 * 60_000,
    scopes: ['relay:connect']
  });
  assert.equal(revoked.includes(replacement.payload.jti), true, 'scope-changing rotation must invalidate the predecessor transport');
  assert.equal(await sessions.isConnectionContinuable(replacement.payload.jti, peer.deviceId), false);
  assert.equal((await sessions.verify(narrowed.token, { audience: 'operator-relay' })).jti, narrowed.payload.jti);
});

test('rotation can atomically refresh signed capability scopes for entitlement changes', async (t) => {
  const a = await device('operator-session-scope-rotate-a-', 'A');
  const b = await device('operator-session-scope-rotate-b-', 'B');
  t.after(() => Promise.all([fs.rm(a.state, { recursive: true, force: true }), fs.rm(b.state, { recursive: true, force: true })]));
  await pairBoth(a, b);

  const bPublic = await b.identity.loadOrCreate();
  const sessions = new DeviceSessionTokenStore(a.state, a.identity, a.registry);
  const first = await sessions.issue({
    subjectDeviceId: bPublic.deviceId,
    audience: 'operator-relay',
    scopes: ['relay:connect', 'cap:file.read'],
    ttlMs: 60_000
  });

  const upgraded = await sessions.rotate(first.payload.jti, {
    ttlMs: 60_000,
    scopes: ['relay:connect', 'relay:result', 'relay:developer', 'cap:file.read', 'cap:docker.manage']
  });
  assert.equal(upgraded.payload.scopes.includes('relay:developer'), true);
  assert.equal(upgraded.payload.scopes.includes('cap:docker.manage'), true);
  await assert.rejects(
    sessions.verify(first.token, { audience: 'operator-relay' }),
    (error: any) => error?.code === 'SESSION_REVOKED'
  );
  assert.equal(
    (await sessions.verify(upgraded.token, { audience: 'operator-relay', requiredScopes: ['relay:developer', 'cap:docker.manage'] })).jti,
    upgraded.payload.jti
  );

  const downgraded = await sessions.rotate(upgraded.payload.jti, {
    ttlMs: 60_000,
    scopes: ['relay:connect', 'relay:result', 'cap:file.read']
  });
  assert.equal(downgraded.payload.scopes.includes('relay:developer'), false);
  assert.equal(downgraded.payload.scopes.includes('cap:docker.manage'), false);
  await assert.rejects(
    sessions.verify(downgraded.token, { audience: 'operator-relay', requiredScopes: ['relay:developer'] }),
    (error: any) => error?.code === 'SESSION_SCOPE_DENIED'
  );
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

test('automatic rotation compacts expired predecessors before the global session registry can fill', async (t) => {
  let nowMs = Date.parse('2026-09-15T00:00:00.000Z');
  const clock = () => new Date(nowMs);
  const a = await device('operator-session-compact-a-', 'A', clock);
  const b = await device('operator-session-compact-b-', 'B', clock);
  t.after(() => Promise.all([fs.rm(a.state, { recursive: true, force: true }), fs.rm(b.state, { recursive: true, force: true })]));
  await pairBoth(a, b);
  const peer = await b.identity.loadOrCreate();
  const sessions = new DeviceSessionTokenStore(a.state, a.identity, a.registry, { clock });
  let current = await sessions.issue({ subjectDeviceId: peer.deviceId, audience: 'operator-relay', scopes: ['relay:connect'], ttlMs: 60_000 });
  const first = current;
  current = await sessions.rotate(current.payload.jti, { ttlMs: 60_000 });
  const replay = await sessions.rotate(first.payload.jti, { ttlMs: 60_000 });
  assert.equal(replay.payload.jti, current.payload.jti);
  for (let i = 0; i < 200; i += 1) {
    nowMs += 45_000;
    current = await sessions.rotate(current.payload.jti, { ttlMs: 60_000 });
  }
  const records = await sessions.listIssued(500);
  assert.equal(records.filter((record) => record.status === 'active').length, 1);
  assert.ok(records.length <= 3, `rotation history should stay bounded, got ${records.length}`);
  assert.equal(records.some((record) => record.jti === first.payload.jti), false);
});

test('independent session stores cannot lose issued tokens or resurrect revoked credentials', async (t) => {
  const a = await device('operator-session-cross-issuer-', 'Issuer');
  const b = await device('operator-session-cross-peer-', 'Peer');
  t.after(() => Promise.all([
    fs.rm(a.state, { recursive: true, force: true }),
    fs.rm(b.state, { recursive: true, force: true })
  ]));
  await pairBoth(a, b);
  const peerId = (await b.identity.loadOrCreate()).deviceId;
  const stores = Array.from({ length: 8 }, () => new DeviceSessionTokenStore(a.state, a.identity, a.registry));
  const options = { subjectDeviceId: peerId, audience: 'operator-relay', scopes: ['relay:connect'], ttlMs: 60_000 };
  const tokens = await Promise.all(Array.from({ length: 12 }, (_, i) => stores[i % stores.length]!.issue(options)));
  assert.equal(new Set(tokens.map((entry) => entry.payload.jti)).size, tokens.length);
  assert.equal((await stores[0]!.listIssued(100)).length, 12);

  const plannedJti = crypto.randomUUID();
  const recovered = await Promise.all([stores[0]!.issueOrRecover({ ...options, jti: plannedJti }), stores[1]!.issueOrRecover({ ...options, jti: plannedJti })]);
  assert.equal(recovered[0]!.payload.jti, plannedJti);
  assert.equal(recovered[1]!.payload.jti, plannedJti);
  assert.equal((await stores[2]!.listIssued(100)).length, 13);

  await Promise.all([
    stores[0]!.revoke(tokens[0]!.payload.jti, 'authority retired'),
    ...Array.from({ length: 8 }, (_, i) => stores[(i + 1) % stores.length]!.issue(options))
  ]);
  const final = await new DeviceSessionTokenStore(a.state, a.identity, a.registry).listIssued(100);
  assert.equal(final.length, 21);
  assert.equal(new Set(final.map((entry) => entry.jti)).size, 21);
  assert.equal(final.find((entry) => entry.jti === tokens[0]!.payload.jti)?.status, 'revoked');
  await assert.rejects(stores[7]!.verify(tokens[0]!.token, { audience: 'operator-relay', expectedSubjectDeviceId: peerId }),
    (error: any) => error?.code === 'SESSION_REVOKED');
  assert.equal((await stores[3]!.verify(tokens[1]!.token, { audience: 'operator-relay' })).jti, tokens[1]!.payload.jti);
});
