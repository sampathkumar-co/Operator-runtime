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

for (const status of ['dead', 'reused'] as const) {
  test('cross-namespace Linux PID ' + status + ' cannot steal task execution', async t => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-task-lease-pidns-'));
    t.after(() => fs.rm(state, { recursive: true, force: true }));
    const taskId = crypto.randomUUID();
    const boot = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const remote = { pid: 42711, started: 'linux-boot-id:' + boot + ':pidns:10001:ticks:100' };
    const leaseDir = path.join(state, 'task-leases');
    await fs.mkdir(leaseDir, { recursive: true });
    const file = path.join(leaseDir, taskId + '.json');
    const record = {
      version: 2, taskId, ownerId: crypto.randomUUID(),
      pid: remote.pid, processInstance: remote, acquiredAt: new Date().toISOString()
    };
    await fs.writeFile(file, JSON.stringify(record));
    let observed = 0;
    const contender = new TaskStore(state, {
      processInstance: { pid: 42712, started: 'linux-boot-id:' + boot + ':pidns:10002:ticks:200' },
      observeProcessInstance: async pid => {
        observed++;
        return status === 'dead' ? { status: 'dead' as const }
          : { status: 'live' as const, identity: {
            pid, started: 'linux-boot-id:' + boot + ':pidns:10002:ticks:101'
          } };
      }
    });
    await assert.rejects(() => contender.acquireExecutionLease(taskId),
      (error: any) => error?.code === 'TASK_ALREADY_RUNNING');
    assert.equal(observed, 0, 'unrelated PID namespace must not even be observed');
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), record);
  });
}

test('same Linux boot and PID namespace permit proven dead task owner recovery', async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-task-recover-local-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const taskId = crypto.randomUUID();
  const boot = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const original = { pid: 42711, started: 'linux-boot-id:' + boot + ':pidns:8888:ticks:100' };
  const leaseDir = path.join(state, 'task-leases');
  await fs.mkdir(leaseDir, { recursive: true });
  await fs.writeFile(path.join(leaseDir, taskId + '.json'), JSON.stringify({
    version: 2, taskId, ownerId: crypto.randomUUID(),
    pid: original.pid, processInstance: original, acquiredAt: new Date().toISOString()
  }));
  const contender = new TaskStore(state, {
    processInstance: { pid: 42712, started: 'linux-boot-id:' + boot + ':pidns:8888:ticks:200' },
    observeProcessInstance: async () => ({ status: 'dead' as const })
  });
  const lease = await contender.acquireExecutionLease(taskId);
  await lease.assertOwned();
  await lease.release();
});
