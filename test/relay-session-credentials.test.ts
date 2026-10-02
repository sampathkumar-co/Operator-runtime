import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { DeviceSecretProtector } from '../src/core/device-identity.ts';
import { OperatorError } from '../src/core/errors.ts';
import {
  RelaySessionCredentialManager,
  assertRelaySessionLifetime,
  deriveRelaySessionRotateUrl,
  type RelayBackgroundRefreshFailure,
  type RelayEnrollmentProvider
} from '../apps/local-agent/src/relay-session-credentials.ts';

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return await fs.realpath(dir);
}

function protector(): DeviceSecretProtector {
  const prefix = Buffer.from('fake-dpapi:');
  return {
    scheme: 'windows-dpapi-current-user',
    async protect(input: Buffer): Promise<Buffer> {
      return Buffer.concat([prefix, Buffer.from(input).reverse()]);
    },
    async unprotect(input: Buffer): Promise<Buffer> {
      if (input.length <= prefix.length || !input.subarray(0, prefix.length).equals(prefix)) {
        throw new Error('bad fake DPAPI ciphertext');
      }
      return Buffer.from(input.subarray(prefix.length)).reverse();
    }
  };
}

function sessionToken(issuedAtMs: number, ttlMs: number, jti = crypto.randomUUID()): string {
  const payload = {
    version: 1,
    purpose: 'operator-session-v1',
    jti,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + ttlMs).toISOString()
  };
  return `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${'s'.repeat(64)}`;
}

function manager(stateDir: string, legacy: string, now: () => Date, fetchImpl?: typeof fetch, enrollment?: RelayEnrollmentProvider, onBackgroundRefreshFailure?: (details: RelayBackgroundRefreshFailure) => void, onCredentialRotated?: (details: { previousJti: string; currentJti: string; expiresAt: string }) => void, random?: () => number) {
  return new RelaySessionCredentialManager({
    stateDir,
    legacyTokenFile: legacy,
    rotateUrl: 'http://127.0.0.1:48000/v1/device-session/rotate',
    protector: protector(),
    allowLoopbackInsecure: true,
    clock: now,
    refreshSkewMs: 60_000,
    fetchImpl,
    enrollment,
    onBackgroundRefreshFailure,
    onCredentialRotated,
    random
  });
}

test('legacy relay token migrates into protected state and plaintext is physically removed', async (t) => {
  const state = await tempDir(t, 'operator-relay-cred-migrate-');
  const legacy = path.join(state, 'relay-session.token');
  const nowMs = Date.parse('2026-09-14T12:00:00.000Z');
  const token = sessionToken(nowMs, 5 * 60_000);
  await fs.writeFile(legacy, `${token}\n`, { mode: 0o600 });
  const credentials = manager(state, legacy, () => new Date(nowMs));
  t.after(() => credentials.stop());

  assert.equal(await credentials.forRequest(), token);
  await assert.rejects(fs.access(legacy));
  const protectedFile = path.join(state, 'relay-session-credential.json');
  const persisted = await fs.readFile(protectedFile, 'utf8');
  assert.equal(persisted.includes(token), false);
  assert.equal(persisted.includes('windows-dpapi-current-user'), true);

  const reloaded = manager(state, legacy, () => new Date(nowMs));
  t.after(() => reloaded.stop());
  assert.equal(await reloaded.forRequest(), token);
});
test('connection refresh rotates near expiry while result requests keep the current unexpired credential', async (t) => {
  const state = await tempDir(t, 'operator-relay-cred-refresh-');
  const legacy = path.join(state, 'relay-session.token');
  let nowMs = Date.parse('2026-09-14T12:00:00.000Z');
  const oldToken = sessionToken(nowMs, 45_000);
  const newToken = sessionToken(nowMs, 5 * 60_000);
  await fs.writeFile(legacy, oldToken, { mode: 0o600 });
  let calls = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${oldToken}`);
    return new Response(JSON.stringify({ ok: true, session: { token: newToken } }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  const credentials = manager(state, legacy, () => new Date(nowMs), fetchImpl);
  t.after(() => credentials.stop());

  assert.equal(await credentials.forRequest(), oldToken);
  assert.equal(calls, 0);
  assert.equal(await credentials.forConnection(), newToken);
  assert.equal(calls, 1);
  assert.equal(await credentials.forRequest(), newToken);
  assert.equal(calls, 1);
});
test('successful credential rotation signals one transport handoff with predecessor and successor identity', async (t) => {
  const state = await tempDir(t, 'operator-relay-cred-handoff-');
  const legacy = path.join(state, 'relay-session.token');
  const nowMs = Date.parse('2026-10-02T12:00:00.000Z');
  const oldJti = crypto.randomUUID();
  const newJti = crypto.randomUUID();
  const oldToken = sessionToken(nowMs, 45_000, oldJti);
  const newToken = sessionToken(nowMs, 5 * 60_000, newJti);
  await fs.writeFile(legacy, oldToken, { mode: 0o600 });
  const fetchImpl = (async () => new Response(JSON.stringify({ ok: true, session: { token: newToken } }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })) as typeof fetch;
  const rotations: Array<{ previousJti: string; currentJti: string; expiresAt: string }> = [];
  const credentials = manager(state, legacy, () => new Date(nowMs), fetchImpl, undefined, undefined, (details) => rotations.push(details));
  t.after(() => credentials.stop());

  assert.equal(await credentials.forConnection(), newToken);
  assert.deepEqual(rotations, [{
    previousJti: oldJti,
    currentJti: newJti,
    expiresAt: new Date(nowMs + 5 * 60_000).toISOString()
  }]);
});

test('terminal refresh denial requires re-enrollment and never falls back to a revoked token', async (t) => {
  const state = await tempDir(t, 'operator-relay-cred-revoked-');
  const legacy = path.join(state, 'relay-session.token');
  const nowMs = Date.parse('2026-09-14T12:00:00.000Z');
  const oldToken = sessionToken(nowMs, 45_000);
  await fs.writeFile(legacy, oldToken, { mode: 0o600 });
  const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: 'SESSION_REVOKED' } }), {
    status: 401,
    headers: { 'content-type': 'application/json' }
  })) as typeof fetch;
  const credentials = manager(state, legacy, () => new Date(nowMs), fetchImpl);
  t.after(() => credentials.stop());

  await assert.rejects(
    credentials.forConnection(),
    (error: any) => error?.code === 'RELAY_SESSION_REENROLL_REQUIRED' && error?.retryable === false
  );
});

test('relay session rotation URL is derived from the authenticated relay authority', () => {
  assert.equal(
    deriveRelaySessionRotateUrl('wss://operator.example/device'),
    'https://operator.example/v1/device-session/rotate'
  );
  assert.equal(
    deriveRelaySessionRotateUrl('ws://127.0.0.1:5000/device'),
    'http://127.0.0.1:5000/v1/device-session/rotate'
  );
});

test('fresh connection enrolls once, protects the first session, and result requests reuse it without re-enrollment', async (t) => {
  const state = await tempDir(t, 'operator-relay-cred-enroll-');
  const legacy = path.join(state, 'relay-session.token');
  const nowMs = Date.parse('2026-09-14T12:00:00.000Z');
  const enrolledToken = sessionToken(nowMs, 5 * 60_000);
  let enrollCalls = 0;
  const enrollment: RelayEnrollmentProvider = {
    async enroll() { enrollCalls += 1; return enrolledToken; },
    stop() {}
  };
  const credentials = manager(state, legacy, () => new Date(nowMs), undefined, enrollment);
  t.after(() => credentials.stop());
  assert.equal(await credentials.forConnection(), enrolledToken);
  assert.equal(enrollCalls, 1);
  assert.equal(await credentials.forRequest(), enrolledToken);
  assert.equal(enrollCalls, 1);
  const persisted = await fs.readFile(path.join(state, 'relay-session-credential.json'), 'utf8');
  assert.equal(persisted.includes(enrolledToken), false);
  await assert.rejects(fs.access(legacy));
});

test('expired credential silently recovers durable device trust and requests transport handoff', async (t) => {
  const state = await tempDir(t, 'operator-relay-cred-known-device-recovery-');
  const legacy = path.join(state, 'relay-session.token');
  const nowMs = Date.parse('2026-10-02T12:00:00.000Z');
  const expiredJti = crypto.randomUUID();
  const recoveredJti = crypto.randomUUID();
  const expiredToken = sessionToken(nowMs - 10 * 60_000, 5 * 60_000, expiredJti);
  const recoveredToken = sessionToken(nowMs, 5 * 60_000, recoveredJti);
  await fs.writeFile(legacy, expiredToken, { mode: 0o600 });
  let recoverCalls = 0;
  let enrollCalls = 0;
  const replacements: Array<{ previousJti: string; currentJti: string; expiresAt: string }> = [];
  const enrollment: RelayEnrollmentProvider = {
    async recover() { recoverCalls += 1; return recoveredToken; },
    async enroll() { enrollCalls += 1; return sessionToken(nowMs, 5 * 60_000); },
    stop() {}
  };
  const credentials = manager(
    state, legacy, () => new Date(nowMs), undefined, enrollment, undefined,
    (details) => replacements.push(details)
  );
  t.after(() => credentials.stop());

  assert.equal(await credentials.forConnection(), recoveredToken);
  assert.equal(recoverCalls, 1);
  assert.equal(enrollCalls, 0, 'trusted device recovery must not surface a pairing ceremony');
  assert.deepEqual(replacements, [{
    previousJti: expiredJti,
    currentJti: recoveredJti,
    expiresAt: new Date(nowMs + 5 * 60_000).toISOString()
  }], 'recovered credential must hand the live transport over to the successor token');
  assert.equal(await credentials.forRequest(), recoveredToken);
});

test('explicitly revoked known-device recovery falls back to interactive enrollment', async (t) => {
  const state = await tempDir(t, 'operator-relay-cred-recovery-reenroll-');
  const legacy = path.join(state, 'relay-session.token');
  const nowMs = Date.parse('2026-10-02T12:00:00.000Z');
  await fs.writeFile(legacy, sessionToken(nowMs - 10 * 60_000, 5 * 60_000), { mode: 0o600 });
  const enrolledToken = sessionToken(nowMs, 5 * 60_000);
  let recoverCalls = 0;
  let enrollCalls = 0;
  const enrollment: RelayEnrollmentProvider = {
    async recover() {
      recoverCalls += 1;
      throw new OperatorError('RELAY_SESSION_REENROLL_REQUIRED', 'device authority was removed', { retryable: false });
    },
    async enroll() { enrollCalls += 1; return enrolledToken; },
    stop() {}
  };
  const credentials = manager(state, legacy, () => new Date(nowMs), undefined, enrollment);
  t.after(() => credentials.stop());

  assert.equal(await credentials.forConnection(), enrolledToken);
  assert.equal(recoverCalls, 1);
  assert.equal(enrollCalls, 1);
});

test('transient recovery failure never escalates into a pairing ceremony', async (t) => {
  const state = await tempDir(t, 'operator-relay-cred-recovery-transient-');
  const legacy = path.join(state, 'relay-session.token');
  const nowMs = Date.parse('2026-10-02T12:00:00.000Z');
  await fs.writeFile(legacy, sessionToken(nowMs - 10 * 60_000, 5 * 60_000), { mode: 0o600 });
  let enrollCalls = 0;
  const enrollment: RelayEnrollmentProvider = {
    async recover() {
      throw new OperatorError('DEVICE_SESSION_RECOVERY_FAILED', 'temporary relay outage', { retryable: true });
    },
    async enroll() { enrollCalls += 1; return sessionToken(nowMs, 5 * 60_000); },
    stop() {}
  };
  const credentials = manager(state, legacy, () => new Date(nowMs), undefined, enrollment);
  t.after(() => credentials.stop());

  await assert.rejects(credentials.forConnection(), (error: any) => error?.code === 'DEVICE_SESSION_RECOVERY_FAILED' && error?.retryable === true);
  assert.equal(enrollCalls, 0, 'temporary infrastructure failure must not ask the user to pair again');
});

test('terminal refresh denial re-enrolls only on connection path', async (t) => {
  const state = await tempDir(t, 'operator-relay-cred-reenroll-');
  const legacy = path.join(state, 'relay-session.token');
  const nowMs = Date.parse('2026-09-14T12:00:00.000Z');
  const oldToken = sessionToken(nowMs, 45_000);
  const newToken = sessionToken(nowMs, 5 * 60_000);
  await fs.writeFile(legacy, oldToken, { mode: 0o600 });
  let enrollCalls = 0;
  const enrollment: RelayEnrollmentProvider = { async enroll() { enrollCalls += 1; return newToken; }, stop() {} };
  const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: 'SESSION_REVOKED' } }), { status: 401, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const credentials = manager(state, legacy, () => new Date(nowMs), fetchImpl, enrollment);
  t.after(() => credentials.stop());
  assert.equal(await credentials.forRequest(), oldToken);
  assert.equal(enrollCalls, 0);
  assert.equal(await credentials.forConnection(), newToken);
  assert.equal(enrollCalls, 1);
  assert.equal(await credentials.forRequest(), newToken);
});

test('result requests never create fresh enrollment authority when no credential exists', async (t) => {
  const state = await tempDir(t, 'operator-relay-cred-result-no-enroll-');
  const legacy = path.join(state, 'relay-session.token');
  const nowMs = Date.parse('2026-09-14T12:00:00.000Z');
  let enrollCalls = 0;
  const enrollment: RelayEnrollmentProvider = { async enroll() { enrollCalls += 1; return sessionToken(nowMs, 5 * 60_000); }, stop() {} };
  const credentials = manager(state, legacy, () => new Date(nowMs), undefined, enrollment);
  t.after(() => credentials.stop());
  await assert.rejects(credentials.forRequest(), (error: any) => error?.code === 'RELAY_SESSION_TOKEN_FILE_MISSING');
  assert.equal(enrollCalls, 0);
});

test('rotation derives from validated result authority and rejects cross-origin bearer exfiltration', () => {
  assert.equal(
    deriveRelaySessionRotateUrl('ws://127.0.0.1:8788/device', 'http://127.0.0.1:8789/v1/device-result', true),
    'http://127.0.0.1:8789/v1/device-session/rotate'
  );
  assert.throws(
    () => deriveRelaySessionRotateUrl('wss://relay.operator.example/device', 'https://evil.example/v1/device-result'),
    /relay-authorized HTTPS origin/
  );
});


test('background refresh failure reports degradation without forcing a transport reconnect', async (t) => {
  const state = await tempDir(t, 'operator-relay-cred-background-failure-');
  const legacy = path.join(state, 'relay-session.token');
  const nowMs = Date.parse('2026-09-14T12:00:00.000Z');
  const token = sessionToken(nowMs, 45_000);
  await fs.writeFile(legacy, token, { mode: 0o600 });

  const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: 'REFRESH_REJECTED' } }), {
    status: 400,
    headers: { 'content-type': 'application/json' }
  })) as typeof fetch;

  let report!: (details: RelayBackgroundRefreshFailure) => void;
  const reported = new Promise<RelayBackgroundRefreshFailure>((resolve) => { report = resolve; });
  let rotations = 0;
  const credentials = manager(
    state, legacy, () => new Date(nowMs), fetchImpl, undefined,
    (details) => report(details),
    () => { rotations += 1; }
  );
  t.after(() => credentials.stop());

  assert.equal(await credentials.forRequest(), token);
  const details = await Promise.race([
    reported,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('background refresh failure was not reported')), 2_500))
  ]);
  assert.deepEqual(details, { code: 'REFRESH_REJECTED', retryable: false });
  assert.equal(rotations, 0, 'failed refresh must not masquerade as a successful rotation/reconnect trigger');
  assert.equal(await credentials.forRequest(), token, 'still-valid credential remains usable while background recovery continues');
});


test('background refresh failure keeps retrying for the lifetime of the credential manager', async (t) => {
  const state = await tempDir(t, 'operator-relay-cred-background-retry-');
  const legacy = path.join(state, 'relay-session.token');
  const nowMs = Date.parse('2026-10-02T12:00:00.000Z');
  const token = sessionToken(nowMs, 45_000);
  await fs.writeFile(legacy, token, { mode: 0o600 });
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { code: 'REFRESH_REJECTED' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  const credentials = manager(state, legacy, () => new Date(nowMs), fetchImpl, undefined, undefined, undefined, () => 0);
  t.after(() => credentials.stop());

  assert.equal(await credentials.forRequest(), token);
  const deadline = Date.now() + 4_500;
  while (calls < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(calls >= 2, `expected repeated background refresh attempts, got ${calls}`);
});

test('relay session lifetime boundary accepts 30 minutes and rejects invalid ranges', () => {
  const issuedAt = Date.parse('2026-09-16T12:00:00.000Z');
  assert.doesNotThrow(() => assertRelaySessionLifetime(issuedAt, issuedAt + 30 * 60_000));
  assert.throws(
    () => assertRelaySessionLifetime(issuedAt, issuedAt + 30 * 60_000 + 1),
    (error: any) => error?.code === 'RELAY_SESSION_TOKEN_INVALID'
  );
  assert.throws(
    () => assertRelaySessionLifetime(issuedAt, issuedAt),
    (error: any) => error?.code === 'RELAY_SESSION_TOKEN_INVALID'
  );
});
