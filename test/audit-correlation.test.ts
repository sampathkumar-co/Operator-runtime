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

test('authenticated audit upgrades a verified v1 head to a generation-bound v3 head and freshness anchor', async (t) => {
  const state = await stateDir(t);
  const unsigned = new AuditLog(state);
  await unsigned.append({ capability: 'legacy', result: 'success', risk: 'read' });

  const before = JSON.parse(await fs.readFile(path.join(state, 'audit-head.json'), 'utf8'));
  assert.equal(before.version, 1);

  const auth = auditAuthenticator();
  const signed = new AuditLog(state, { authenticator: auth });
  assert.equal((await signed.verifyIntegrity()).count, 1);

  const after = JSON.parse(await fs.readFile(path.join(state, 'audit-head.json'), 'utf8'));
  assert.equal(after.version, 3);
  assert.equal(after.generation, 1);
  assert.equal(after.signerKeyId, auth.keyId);
  assert.match(after.signature, /^[A-Za-z0-9_-]{40,512}$/);
  const freshness = JSON.parse(await fs.readFile(path.join(state, 'audit-freshness.json'), 'utf8'));
  assert.equal(freshness.generation, 1);
  assert.equal(freshness.count, after.count);
  assert.equal(freshness.headHash, after.headHash);
});

test('authenticated audit rejects a tampered signed head even when its chain coordinates look plausible', async (t) => {
  const state = await stateDir(t);
  const auth = auditAuthenticator();
  const audit = new AuditLog(state, { authenticator: auth });
  await audit.append({ capability: 'signed', result: 'success', risk: 'read' });

  const headPath = path.join(state, 'audit-head.json');
  const head = JSON.parse(await fs.readFile(headPath, 'utf8'));
  assert.equal(head.version, 3);
  head.signature = 'A'.repeat(86);
  await fs.writeFile(headPath, JSON.stringify(head, null, 2) + '\n');

  await assert.rejects(
    () => new AuditLog(state, { authenticator: auth }).verifyIntegrity(),
    (error: any) => error?.code === 'AUDIT_INTEGRITY_FAILED' && /signature/i.test(error.message)
  );
});

test('authenticated audit migrates a verified signed v2 head without losing chain coordinates', async (t) => {
  const state = await stateDir(t);
  const unsigned = new AuditLog(state);
  await unsigned.append({ capability: 'legacy-v2', result: 'success', risk: 'read' });
  const coordinates = JSON.parse(await fs.readFile(path.join(state, 'audit-head.json'), 'utf8'));
  const auth = auditAuthenticator();
  const payload = Buffer.from(JSON.stringify({
    purpose: 'mecord-audit-head-v2',
    count: coordinates.count,
    headHash: coordinates.headHash,
    signerKeyId: auth.keyId
  }), 'utf8');
  const v2 = {
    version: 2,
    count: coordinates.count,
    headHash: coordinates.headHash,
    updatedAt: new Date().toISOString(),
    signerKeyId: auth.keyId,
    signature: await auth.sign(payload)
  };
  await fs.writeFile(path.join(state, 'audit-head.json'), JSON.stringify(v2, null, 2) + '\n');

  await new AuditLog(state, { authenticator: auth }).verifyIntegrity();
  const migrated = JSON.parse(await fs.readFile(path.join(state, 'audit-head.json'), 'utf8'));
  assert.equal(migrated.version, 3);
  assert.equal(migrated.generation, 1);
  assert.equal(migrated.headHash, coordinates.headHash);
});

test('older authentic signed audit history is rejected as stale after a newer generation was accepted', async (t) => {
  const state = await stateDir(t);
  const auth = auditAuthenticator();
  const audit = new AuditLog(state, { authenticator: auth });
  await audit.append({ capability: 'generation.one', result: 'success', risk: 'read' });
  const oldLog = await fs.readFile(path.join(state, 'audit.ndjson'));
  const oldHead = await fs.readFile(path.join(state, 'audit-head.json'));
  await audit.append({ capability: 'generation.two', result: 'success', risk: 'read' });
  const currentFreshness = JSON.parse(await fs.readFile(path.join(state, 'audit-freshness.json'), 'utf8'));
  assert.equal(currentFreshness.generation, 2);

  await fs.writeFile(path.join(state, 'audit.ndjson'), oldLog);
  await fs.writeFile(path.join(state, 'audit-head.json'), oldHead);
  await assert.rejects(
    new AuditLog(state, { authenticator: auth }).verifyIntegrity(),
    (error: any) => error?.code === 'AUDIT_FRESHNESS_STALE' && /stale/i.test(error.message)
  );
});

test('audit freshness generation survives restart and rejects an older authentic anchor', async (t) => {
  const state = await stateDir(t);
  const auth = auditAuthenticator();
  const first = new AuditLog(state, { authenticator: auth });
  await first.append({ capability: 'one', result: 'success', risk: 'read' });
  const oldFreshness = await fs.readFile(path.join(state, 'audit-freshness.json'));
  await new AuditLog(state, { authenticator: auth }).append({ capability: 'two', result: 'success', risk: 'read' });
  const head = JSON.parse(await fs.readFile(path.join(state, 'audit-head.json'), 'utf8'));
  assert.equal(head.generation, 2);

  await fs.writeFile(path.join(state, 'audit-freshness.json'), oldFreshness);
  await assert.rejects(
    new AuditLog(state, { authenticator: auth }).verifyIntegrity(),
    (error: any) => error?.code === 'AUDIT_FRESHNESS_STALE' && /older/i.test(error.message)
  );
});

test('audit freshness rejects generation tamper and serializes concurrent append generations', async (t) => {
  const state = await stateDir(t);
  const auth = auditAuthenticator();
  const audit = new AuditLog(state, { authenticator: auth });
  await Promise.all(Array.from({ length: 12 }, (_, index) => audit.append({
    capability: `concurrent.${index}`,
    result: 'success',
    risk: 'read'
  })));
  const head = JSON.parse(await fs.readFile(path.join(state, 'audit-head.json'), 'utf8'));
  const freshnessPath = path.join(state, 'audit-freshness.json');
  const freshness = JSON.parse(await fs.readFile(freshnessPath, 'utf8'));
  assert.equal(head.generation, 12);
  assert.equal(freshness.generation, 12);
  assert.equal(freshness.count, 12);

  freshness.generation = 11;
  await fs.writeFile(freshnessPath, JSON.stringify(freshness, null, 2) + '\n');
  await assert.rejects(
    new AuditLog(state, { authenticator: auth }).verifyIntegrity(),
    (error: any) => error?.code === 'AUDIT_FRESHNESS_STALE' && /signature/i.test(error.message)
  );
});

test('authenticated audit recovers only exact one-write append commit windows', async (t) => {
  const state = await stateDir(t);
  const auth = auditAuthenticator();
  const audit = new AuditLog(state, { authenticator: auth });
  await audit.append({ capability: 'one', result: 'success', risk: 'read' });
  const oldHead = await fs.readFile(path.join(state, 'audit-head.json'));
  const oldFreshness = await fs.readFile(path.join(state, 'audit-freshness.json'));
  await audit.append({ capability: 'two', result: 'success', risk: 'read' });
  const newFreshness = JSON.parse(await fs.readFile(path.join(state, 'audit-freshness.json'), 'utf8'));

  await fs.writeFile(path.join(state, 'audit-head.json'), oldHead);
  await new AuditLog(state, { authenticator: auth }).verifyIntegrity();
  assert.equal(JSON.parse(await fs.readFile(path.join(state, 'audit-head.json'), 'utf8')).generation, 2);

  await fs.writeFile(path.join(state, 'audit-head.json'), oldHead);
  await fs.writeFile(path.join(state, 'audit-freshness.json'), oldFreshness);
  await new AuditLog(state, { authenticator: auth }).verifyIntegrity();
  assert.equal(JSON.parse(await fs.readFile(path.join(state, 'audit-freshness.json'), 'utf8')).generation, 2);
  const recoveredFreshness = JSON.parse(await fs.readFile(path.join(state, 'audit-freshness.json'), 'utf8'));
  assert.equal(recoveredFreshness.generation, newFreshness.generation);
  assert.equal(recoveredFreshness.count, newFreshness.count);
  assert.equal(recoveredFreshness.headHash, newFreshness.headHash);
});
