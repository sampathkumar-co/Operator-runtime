import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskStore } from '../src/core/task-store.ts';

for (const field of ['version', 'pid', 'taskId', 'ownerId'] as const) {
  test('execution lease rejects coerced persisted ' + field + ' before claiming ownership', async (t) => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-task-lease-json-type-'));
    t.after(() => fs.rm(state, { recursive: true, force: true }));
    const taskId = crypto.randomUUID();
    const store = new TaskStore(state);
    const lease = await store.acquireExecutionLease(taskId);
    const file = path.join(state, 'task-leases', taskId + '.json');
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    switch (field) {
      case 'version': record.version = '2'; break;
      case 'pid': record.pid = String(record.pid); break;
      case 'taskId': record.taskId = [record.taskId]; break;
      case 'ownerId': record.ownerId = [record.ownerId]; break;
    }
    await fs.writeFile(file, JSON.stringify(record), { mode: 0o600 });
    await assert.rejects(lease.assertOwned(),
      (error: any) => error?.code === 'TASK_LEASE_CORRUPT');
    await assert.rejects(new TaskStore(state).acquireExecutionLease(taskId),
      (error: any) => error?.code === 'TASK_LEASE_CORRUPT');
  });
}

test('boolean lease version cannot be used as numeric legacy version', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-task-lease-bool-version-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const id = crypto.randomUUID();
  const lease = await new TaskStore(state).acquireExecutionLease(id);
  const file = path.join(state, 'task-leases', id + '.json');
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  record.version = true;
  await fs.writeFile(file, JSON.stringify(record), { mode: 0o600 });
  await assert.rejects(lease.assertOwned(),
    (error: any) => error?.code === 'TASK_LEASE_CORRUPT');
});
