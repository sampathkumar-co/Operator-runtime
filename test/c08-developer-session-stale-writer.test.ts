import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDeveloperSession, DeveloperSessionStore, updateDeveloperSession } from '../src/core/developer-session.ts';

async function fixture(t: test.TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-c08-session-writer-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const first = new DeveloperSessionStore(dir);
  const second = new DeveloperSessionStore(dir);
  const created = createDeveloperSession({
    objective: 'Reconcile session ownership without stale writes',
    acceptanceCriteria: ['Only the newest durable state remains'],
    workspaceRootNodeId: 'authorized-root',
    now: '2026-10-26T00:00:00.000Z'
  });
  await first.put(created);
  return { first, second, created, dir };
}

test('C08 old or equally timestamped conflicting session cannot overwrite newer verified state', async t => {
  const { first, second, created } = await fixture(t);
  const older = updateDeveloperSession(created, { status: 'ACTIVE', taskIds: ['task-a'] },
    '2026-10-26T00:00:01.000Z');
  const newer = updateDeveloperSession(created, { status: 'VERIFYING', taskIds: ['task-a', 'task-b'] },
    '2026-10-26T00:00:02.000Z');
  await first.put(older);
  await second.put(newer);
  await assert.rejects(first.put(older),
    (error: any) => error?.code === 'DEVELOPER_SESSION_STALE_WRITE');
  const conflicting = { ...newer, status: 'FAILED' as const };
  await assert.rejects(first.put(conflicting),
    (error: any) => error?.code === 'DEVELOPER_SESSION_STALE_WRITE');
  // Idempotent re-persist of the exact accepted record remains safe.
  await second.put(newer);
  assert.deepEqual(await first.get(created.id), newer);
});

test('C08 independent writer objects converge on highest timestamp under concurrent writes', async t => {
  const { first, second, created } = await fixture(t);
  const proposals = Array.from({ length: 14 }, (_, i) =>
    updateDeveloperSession(created, { status: 'ACTIVE', taskIds: ['task-' + i] },
      new Date(Date.parse(created.updatedAt) + i + 1).toISOString()));
  const results = await Promise.allSettled(proposals.map((value,i) =>
    (i % 2 ? first : second).put(value)));
  assert.ok(results.some(result => result.status === 'fulfilled'));
  for (const item of results) {
    if (item.status === 'rejected') {
      assert.equal((item.reason as any)?.code, 'DEVELOPER_SESSION_STALE_WRITE');
    }
  }
  assert.deepEqual(await first.get(created.id), proposals.at(-1));
});
