import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditLog } from '../src/core/audit.ts';

async function stateDir(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-audit-correlation-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('audit correlation fields remain hash-chained and queryable', async (t) => {
  const audit = new AuditLog(await stateDir(t));
  await audit.append({
    traceId: 'trace-1',
    operationId: 'operation-1',
    missionId: 'mission-1',
    workItemId: 'work-1',
    workerId: 'worker-1',
    actionId: 'action-1',
    providerId: 'provider-a',
    capability: 'file.read',
    result: 'success',
    risk: 'read',
    details: { durationMs: 12 }
  });
  await audit.append({
    traceId: 'trace-2',
    taskId: 'task-2',
    actionId: 'action-2',
    providerId: 'provider-b',
    capability: 'file.write',
    result: 'failure',
    risk: 'write',
    details: { durationMs: 30 }
  });

  const first = await audit.query({ traceId: 'trace-1' });
  assert.equal(first.length, 1);
  assert.equal(first[0]?.missionId, 'mission-1');
  assert.equal(first[0]?.providerId, 'provider-a');
  assert.equal((await audit.verifyIntegrity()).valid, true);
});

test('audit summary is bounded and reconstructs provider/capability outcomes', async (t) => {
  const audit = new AuditLog(await stateDir(t));
  await audit.append({
    traceId: 'trace',
    providerId: 'provider-a',
    capability: 'file.read',
    result: 'success',
    risk: 'read',
    details: { durationMs: 10 }
  });
  await audit.append({
    traceId: 'trace',
    providerId: 'provider-a',
    capability: 'file.write',
    result: 'blocked',
    risk: 'write',
    details: { durationMs: 20 }
  });

  const summary = await audit.summary({ traceId: 'trace' });
  assert.deepEqual(summary, {
    total: 2,
    success: 1,
    failure: 0,
    blocked: 1,
    allowed: 0,
    byCapability: { 'file.read': 1, 'file.write': 1 },
    byProvider: { 'provider-a': 2 },
    averageDurationMs: 15
  });
});

test('correlation metadata is still redacted when a secret-like field is supplied', async (t) => {
  const state = await stateDir(t);
  const audit = new AuditLog(state);
  await audit.append({
    traceId: 'trace-safe',
    capability: 'probe',
    result: 'success',
    risk: 'read',
    details: { token: 'must-not-survive', nested: { password: 'also-secret' } }
  });
  const raw = await fs.readFile(path.join(state, 'audit.ndjson'), 'utf8');
  assert.equal(raw.includes('must-not-survive'), false);
  assert.equal(raw.includes('also-secret'), false);
});


function auditAuthenticator() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    keyId: crypto.createHash('sha256').update(publicPem).digest('base64url'),
    sign: async (payload: Uint8Array) => crypto.sign(null, payload, privateKey).toString('base64url'),
    verify: async (payload: Uint8Array, signature: string) =>
      crypto.verify(null, payload, publicKey, Buffer.from(signature, 'base64url'))
  };
}

test('authenticated audit upgrades a verified v1 head to a device-signed v2 anchor', async (t) => {
  const state = await stateDir(t);
  const unsigned = new AuditLog(state);
  await unsigned.append({ capability: 'legacy', result: 'success', risk: 'read' });

  const before = JSON.parse(await fs.readFile(path.join(state, 'audit-head.json'), 'utf8'));
  assert.equal(before.version, 1);

  const auth = auditAuthenticator();
  const signed = new AuditLog(state, { authenticator: auth });
  assert.equal((await signed.verifyIntegrity()).count, 1);

  const after = JSON.parse(await fs.readFile(path.join(state, 'audit-head.json'), 'utf8'));
  assert.equal(after.version, 2);
  assert.equal(after.signerKeyId, auth.keyId);
  assert.match(after.signature, /^[A-Za-z0-9_-]{40,512}$/);
});

test('authenticated audit rejects a tampered signed head even when its chain coordinates look plausible', async (t) => {
  const state = await stateDir(t);
  const auth = auditAuthenticator();
  const audit = new AuditLog(state, { authenticator: auth });
  await audit.append({ capability: 'signed', result: 'success', risk: 'read' });

  const headPath = path.join(state, 'audit-head.json');
  const head = JSON.parse(await fs.readFile(headPath, 'utf8'));
  assert.equal(head.version, 2);
  head.signature = 'A'.repeat(86);
  await fs.writeFile(headPath, JSON.stringify(head, null, 2) + '\n');

  await assert.rejects(
    () => new AuditLog(state, { authenticator: auth }).verifyIntegrity(),
    (error: any) => error?.code === 'AUDIT_INTEGRITY_FAILED' && /signature/i.test(error.message)
  );
});
