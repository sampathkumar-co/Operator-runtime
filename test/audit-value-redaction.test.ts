import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditLog } from '../src/core/audit.ts';

async function stateDir(t: test.TestContext): Promise<string> {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-audit-value-redaction-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  return state;
}

test('audit redacts credential and regulated values hidden behind benign keys and arrays', async (t) => {
  const state = await stateDir(t);
  const bearer = 'Bearer abcdefghijklmnopqrstuvwxyz';
  const github = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
  const privateKey = '-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----';
  const credentialedUrl = 'https://user:password@example.invalid/path';
  const paymentCard = '4111 1111 1111 1111';
  const database = 'postgresql://operator:database-password@localhost/runtime';
  const log = new AuditLog(state);

  const appended = await log.append({
    capability: 'audit.probe', result: 'success', risk: 'read',
    details: {
      message: bearer,
      note: github,
      nested: { description: privateKey, endpoint: credentialedUrl },
      values: [paymentCard, { diagnostic: database }]
    }
  });

  assert.deepEqual(appended.details, {
    message: '[REDACTED]',
    note: '[REDACTED]',
    nested: { description: '[REDACTED]', endpoint: '[REDACTED]' },
    values: ['[REDACTED]', { diagnostic: '[REDACTED]' }]
  });
  const raw = await fs.readFile(path.join(state, 'audit.ndjson'), 'utf8');
  for (const secret of [bearer, github, 'secret-material', credentialedUrl, paymentCard, database]) {
    assert.equal(raw.includes(secret), false, `audit persisted restricted value: ${secret}`);
  }
  assert.equal((await log.verifyIntegrity()).valid, true);
});

test('audit uses the canonical sensitive-key vocabulary at every nesting level', async (t) => {
  const log = new AuditLog(await stateDir(t));
  const [event] = [await log.append({
    capability: 'audit.probe', result: 'success', risk: 'read',
    details: {
      credential: 'opaque-value',
      passwd: 'short',
      nested: { cvv: 123, patientId: 'patient-123', accessKeyId: 'opaque-access-key' }
    }
  })];
  assert.deepEqual(event.details, {
    credential: '[REDACTED]',
    passwd: '[REDACTED]',
    nested: { cvv: '[REDACTED]', patientId: '[REDACTED]', accessKeyId: '[REDACTED]' }
  });
});

test('audit preserves ordinary operational values, identifiers, hashes, and credential-free URLs', async (t) => {
  const log = new AuditLog(await stateDir(t));
  const safe = {
    message: 'provider request completed normally',
    digest: 'a'.repeat(64),
    action: 'action-123',
    endpoint: 'https://example.invalid/path?mode=read',
    durationMs: 42
  };
  const event = await log.append({ capability: 'audit.probe', result: 'success', risk: 'read', details: safe });
  assert.deepEqual(event.details, safe);
});

test('legacy unchained audit migration removes value-level secrets before creating the trusted chain', async (t) => {
  const state = await stateDir(t);
  const leaked = 'Bearer legacy-credential-material';
  await fs.writeFile(path.join(state, 'audit.ndjson'), `${JSON.stringify({
    id: 'legacy-event', timestamp: '2026-10-06T00:00:00.000Z',
    capability: 'legacy', result: 'success', risk: 'read', details: { message: leaked }
  })}\n`);

  const [event] = await new AuditLog(state).tail(1);
  assert.equal(event?.details?.message, '[REDACTED]');
  const migrated = await fs.readFile(path.join(state, 'audit.ndjson'), 'utf8');
  assert.equal(migrated.includes(leaked), false);
  assert.match(String(event?.hash), /^[0-9a-f]{64}$/);
});
