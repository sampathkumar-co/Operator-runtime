import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccountDeviceRegistry } from '../src/core/account-device-registry.ts';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { DeviceRegistryStore, answerPairingChallenge } from '../src/core/device-registry.ts';
import { PolicyEngine } from '../src/core/policy.ts';
import { DeviceSessionTokenStore } from '../src/core/session-token.ts';
import { EmergencyStopStore } from '../apps/local-agent/src/emergency-stop.ts';
import { LocalPrivacyDataStore } from '../apps/local-agent/src/privacy-data.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

async function temp(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function pair(authority: DeviceIdentityStore, devices: DeviceRegistryStore, peer: DeviceIdentityStore): Promise<void> {
  const authorityPublic = await authority.loadOrCreate('Authority');
  const peerPublic = await peer.loadOrCreate('Peer');
  const challenge = await devices.issuePairingChallenge(authorityPublic, {
    expectedPeerDeviceId: peerPublic.deviceId,
    ttlMs: 60_000
  });
  await devices.completePairing(await answerPairingChallenge(challenge, peer));
}

test('observed content cannot become execution authority even when it asks for an otherwise allowed capability', () => {
  const policy = new PolicyEngine();
  const permissions = {
    allowedCapabilities: ['file.*', 'terminal.execute', 'browser.*'],
    allowedRoots: [process.cwd()],
    allowExternalWrites: true,
    allowSystemChanges: true,
    allowDestructive: true
  };
  for (const kind of ['website', 'file', 'application', 'terminal'] as const) {
    assert.throws(
      () => policy.authorize({
        id: `attack-${kind}`,
        capability: 'terminal.execute',
        risk: 'destructive',
        input: { cwd: process.cwd(), executable: 'node' },
        provenance: { kind }
      }, permissions),
      (error: any) => error?.code === 'UNTRUSTED_INSTRUCTION_SOURCE'
    );
  }
});

test('path normalization and approval IDs cannot authorize a path outside the local scope', () => {
  const policy = new PolicyEngine();
  const root = path.resolve(os.tmpdir(), 'operator-redteam-authorized-root');
  const sibling = path.resolve(root, '..', 'operator-redteam-secret', 'secret.txt');
  assert.throws(
    () => policy.authorize({
      id: 'pre-approved-but-outside',
      capability: 'file.write',
      risk: 'destructive',
      input: { path: sibling },
      provenance: { kind: 'user' }
    }, {
      allowedCapabilities: ['file.*'],
      allowedRoots: [root],
      approvedActionIds: ['pre-approved-but-outside'],
      allowDestructive: true
    }),
    (error: any) => error?.code === 'PATH_OUTSIDE_SCOPE'
  );
});

test('emergency stop cannot be bypassed with query strings and ordinary agent auth cannot recover or erase privacy state', async (t) => {
  const root = await temp(t, 'operator-redteam-agent-root-');
  const state = await temp(t, 'operator-redteam-agent-state-');
  const token = 'a'.repeat(64);
  const recovery = 'r'.repeat(64);
  const identity = new DeviceIdentityStore(state);
  const local = await identity.loadOrCreate('Red Team PC');
  await fs.writeFile(path.join(state, 'audit.ndjson'), '{"event":"must-remain"}\n', { mode: 0o600 });
  const runtime = createRuntime({ allowedRoots: [root], allowedExecutables: ['node'] });
  const agent = createLocalAgentServer({
    runtime,
    token,
    recoveryToken: recovery,
    emergencyStop: new EmergencyStopStore(state),
    privacy: new LocalPrivacyDataStore(state),
    deviceIdentity: identity,
    permissions: { allowedCapabilities: ['computer.inspect'], allowedRoots: [root] }
  });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const bound = await agent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${bound.port}`;
  const auth = { authorization: `Bearer ${token}` };

  assert.equal((await fetch(`${base}/v1/emergency-stop`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}'
  })).status, 200);

  const bypass = await fetch(`${base}/v1/execute?ignoreEmergencyStop=1`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ action: {
      id: 'redteam-bypass', capability: 'computer.inspect', risk: 'read', input: {}, provenance: { kind: 'user' }
    } })
  });
  assert.equal(bypass.status, 423);
  assert.equal((await bypass.json() as any).error.code, 'EMERGENCY_STOPPED');

  const clearWithAgentToken = await fetch(`${base}/v1/emergency-stop`, {
    method: 'DELETE', headers: { ...auth, 'x-operator-recovery-token': token }
  });
  assert.equal(clearWithAgentToken.status, 401);

  const eraseWithAgentToken = await fetch(`${base}/v1/privacy/activity`, {
    method: 'DELETE', headers: { ...auth, 'x-operator-recovery-token': token }
  });
  assert.equal(eraseWithAgentToken.status, 401);
  await fs.access(path.join(state, 'audit.ndjson'));

  const traversal = await fetch(`${base}/v1/privacy/%2e%2e%2fdevice-identity`, {
    method: 'DELETE', headers: { ...auth, 'x-operator-recovery-token': recovery }
  });
  assert.ok([400, 404].includes(traversal.status));
  const identityText = await fs.readFile(path.join(state, 'device-identity.json'), 'utf8');
  assert.equal(identityText.includes(local.deviceId), true);
});

test('companion device surface never exposes private/public key PEM material', async (t) => {
  const root = await temp(t, 'operator-redteam-device-root-');
  const state = await temp(t, 'operator-redteam-device-state-');
  const token = 'd'.repeat(64);
  const identity = new DeviceIdentityStore(state);
  await identity.loadOrCreate('Key Exposure Test');
  const runtime = createRuntime({ allowedRoots: [root], allowedExecutables: ['node'] });
  const agent = createLocalAgentServer({
    runtime,
    token,
    deviceIdentity: identity,
    deviceRegistry: new DeviceRegistryStore(state),
    permissions: { allowedCapabilities: ['computer.inspect'], allowedRoots: [root] }
  });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const bound = await agent.listen('127.0.0.1', 0);
  const response = await fetch(`http://127.0.0.1:${bound.port}/v1/devices`, {
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(/PRIVATE KEY|PUBLIC KEY|privateKey|publicKeyPem/.test(text), false);
});

test('tampering a relay session capability scope invalidates the Ed25519 signature', async (t) => {
  const authorityState = await temp(t, 'operator-redteam-session-authority-');
  const peerState = await temp(t, 'operator-redteam-session-peer-');
  const authority = new DeviceIdentityStore(authorityState);
  const peer = new DeviceIdentityStore(peerState);
  const authorityDevices = new DeviceRegistryStore(authorityState);
  const peerDevices = new DeviceRegistryStore(peerState);
  await pair(authority, authorityDevices, peer);
  await pair(peer, peerDevices, authority);
  const peerPublic = await peer.loadOrCreate();
  const issuerSessions = new DeviceSessionTokenStore(authorityState, authority, authorityDevices);
  const peerSessions = new DeviceSessionTokenStore(peerState, peer, peerDevices);
  const issued = await issuerSessions.issue({
    subjectDeviceId: peerPublic.deviceId,
    audience: 'operator-relay',
    scopes: ['relay:connect', 'cap:file.read'],
    ttlMs: 60_000
  });

  const [, signaturePart] = issued.token.split('.');
  const payload = issued.payload;
  const forgedCanonical = {
    version: 1,
    purpose: 'operator-session-v1',
    jti: payload.jti,
    issuerDeviceId: payload.issuerDeviceId,
    issuerFingerprint: payload.issuerFingerprint,
    subjectDeviceId: payload.subjectDeviceId,
    subjectFingerprint: payload.subjectFingerprint,
    audience: payload.audience,
    scopes: ['cap:file.read', 'cap:git.write', 'relay:connect'],
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt
  };
  const forgedPayload = Buffer.from(JSON.stringify(forgedCanonical), 'utf8').toString('base64url');
  await assert.rejects(
    peerSessions.verify(`${forgedPayload}.${signaturePart}`, {
      audience: 'operator-relay', requiredScopes: ['cap:git.write']
    }),
    (error: any) => error?.code === 'SESSION_SIGNATURE_INVALID'
  );
});

test('account authority persists a hash of upstream identity rather than the raw principal', async (t) => {
  const state = await temp(t, 'operator-redteam-account-state-');
  const authority = new DeviceIdentityStore(state);
  const peerState = await temp(t, 'operator-redteam-account-peer-');
  const peer = new DeviceIdentityStore(peerState);
  const devices = new DeviceRegistryStore(state);
  await pair(authority, devices, peer);
  const accounts = new AccountDeviceRegistry(state, devices);
  const principal = { issuer: 'https://identity.example.invalid/private-tenant', subject: 'sensitive-user-subject' };
  await accounts.resolveOrCreateAccount(principal);
  const stored = await fs.readFile(path.join(state, 'account-devices.json'), 'utf8');
  assert.equal(stored.includes(principal.issuer), false);
  assert.equal(stored.includes(principal.subject), false);
});
