import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireRelayStateInstanceLock } from '../src/state-instance-lock.ts';

test('relay state lock rejects a second live process and releases only its own record', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-relay-lock-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const inspect = async (pid: number) => pid === 51001 ? { pid, started: 'relay-one' } : null;
  const first = await acquireRelayStateInstanceLock(state, {
    pid: 51001, processInstance: { pid: 51001, started: 'relay-one' }, token: 'a'.repeat(32), inspectProcessInstance: inspect
  });
  t.after(() => first.release());

  await assert.rejects(
    acquireRelayStateInstanceLock(state, {
      pid: 51002, processInstance: { pid: 51002, started: 'relay-two' }, token: 'b'.repeat(32), inspectProcessInstance: inspect
    }),
    (error: unknown) => (error as { code?: string }).code === 'RELAY_ALREADY_RUNNING'
  );
  await first.release();
  await assert.rejects(fs.stat(path.join(state, 'relay-server.lock')), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
});

test('relay state lock reclaims a dead or PID-reused owner', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-relay-stale-lock-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  await fs.writeFile(path.join(state, 'relay-server.lock'), JSON.stringify({
    version: 1,
    pid: 52001,
    processInstance: { pid: 52001, started: 'old-instance' },
    token: 'c'.repeat(32),
    createdAt: '2026-10-01T00:00:00.000Z'
  }));

  const lock = await acquireRelayStateInstanceLock(state, {
    pid: 52002,
    processInstance: { pid: 52002, started: 'new-instance' },
    token: 'd'.repeat(32),
    inspectProcessInstance: async (pid) => pid === 52001 ? { pid, started: 'reused-instance' } : null
  });
  const record = JSON.parse(await fs.readFile(path.join(state, 'relay-server.lock'), 'utf8'));
  assert.equal(record.pid, 52002);
  await lock.release();
});
