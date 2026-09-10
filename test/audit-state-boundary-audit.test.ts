import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditLog } from '../src/core/audit.ts';

async function tempState(t: test.TestContext, prefix: string): Promise<string> {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  return await fs.realpath(state);
}

async function makeFileSymlinkOrSkip(t: test.TestContext, target: string, link: string): Promise<boolean> {
  try {
    await fs.symlink(target, link, 'file');
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      t.skip(`file symlink creation is unavailable on this runner (${code})`);
      return false;
    }
    throw error;
  }
}

test('audit append refuses a symlinked log without modifying its target', async (t) => {
  const state = await tempState(t, 'operator-audit-log-link-');
  const outside = path.join(state, 'outside.ndjson');
  const auditFile = path.join(state, 'audit.ndjson');
  const original = '{"outside":true}\n';
  await fs.writeFile(outside, original, { mode: 0o600 });
  if (!(await makeFileSymlinkOrSkip(t, outside, auditFile))) return;

  await assert.rejects(
    () => new AuditLog(state).append({ capability: 'test', result: 'success', risk: 'read' }),
    (error: any) => error?.code === 'AUDIT_INTEGRITY_FAILED'
  );
  assert.equal(await fs.readFile(outside, 'utf8'), original);
});

test('audit verification refuses a symlinked head anchor without modifying its target', async (t) => {
  const state = await tempState(t, 'operator-audit-head-link-');
  await new AuditLog(state).append({ capability: 'one', result: 'success', risk: 'read' });

  const headFile = path.join(state, 'audit-head.json');
  const outside = path.join(state, 'outside-head.json');
  const original = '{"outside":true}\n';
  await fs.rm(headFile);
  await fs.writeFile(outside, original, { mode: 0o600 });
  if (!(await makeFileSymlinkOrSkip(t, outside, headFile))) return;

  await assert.rejects(
    () => new AuditLog(state).verifyIntegrity(),
    (error: any) => error?.code === 'AUDIT_INTEGRITY_FAILED' && /head metadata is unreadable/.test(error.message)
  );
  assert.equal(await fs.readFile(outside, 'utf8'), original);
});

test('audit rejects an oversized event before appending any record', async (t) => {
  const state = await tempState(t, 'operator-audit-oversize-');
  const details: Record<string, unknown> = {};
  for (let index = 0; index < 1000; index += 1) details[`field_${index}`] = 'x'.repeat(400);

  await assert.rejects(
    () => new AuditLog(state).append({ capability: 'oversized', result: 'success', risk: 'read', details }),
    (error: any) => error?.code === 'AUDIT_EVENT_TOO_LARGE'
  );
  assert.deepEqual(await new AuditLog(state).verifyIntegrity(), { valid: true, count: 0, headHash: null });
});

test('audit redaction bounds large collections and records truncation explicitly', async (t) => {
  const state = await tempState(t, 'operator-audit-collection-bound-');
  const log = new AuditLog(state);
  await log.append({
    capability: 'bounded',
    result: 'success',
    risk: 'read',
    details: { values: Array.from({ length: 1005 }, (_, index) => index) }
  });
  const [event] = await log.tail(Number.NaN);
  const values = (event.details as any).values as unknown[];
  assert.equal(values.length, 1001);
  assert.equal(values.at(-1), '[TRUNCATED_5_ITEMS]');
});
