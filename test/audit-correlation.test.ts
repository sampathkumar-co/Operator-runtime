import assert from 'node:assert/strict';
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
