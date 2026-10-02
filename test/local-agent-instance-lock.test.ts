import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireLocalAgentStateInstanceLock } from '../apps/local-agent/src/state-instance-lock.ts';

test('local-agent state lock rejects a second live runtime', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-instance-lock-live-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const first = await acquireLocalAgentStateInstanceLock(state, { pid: 41001, token: 'a'.repeat(32), isProcessAlive: (pid) => pid === 41001 });
  t.after(() => first.release());
  await assert.rejects(
    acquireLocalAgentStateInstanceLock(state, { pid: 41002, token: 'b'.repeat(32), isProcessAlive: (pid) => pid === 41001 }),
    (error: any) => error?.code === 'LOCAL_AGENT_ALREADY_RUNNING' && /pid 41001/.test(error?.message ?? '')
  );
});

test('local-agent state lock recovers a stale dead-pid lock', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-instance-lock-stale-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  await fs.writeFile(path.join(state, 'local-agent.lock'), JSON.stringify({
    version: 1, pid: 49999, token: 's'.repeat(32), createdAt: '2026-09-29T00:00:00.000Z'
  }));
  const lock = await acquireLocalAgentStateInstanceLock(state, { pid: 41003, token: 'c'.repeat(32), isProcessAlive: () => false });
  const stored = JSON.parse(await fs.readFile(path.join(state, 'local-agent.lock'), 'utf8'));
  assert.equal(stored.pid, 41003);
  assert.equal(stored.token, 'c'.repeat(32));
  await lock.release();
  await assert.rejects(fs.stat(path.join(state, 'local-agent.lock')), (error: any) => error?.code === 'ENOENT');
});

test('local-agent state lock fails closed on malformed existing state', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-instance-lock-invalid-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  await fs.writeFile(path.join(state, 'local-agent.lock'), '{not-json');
  await assert.rejects(
    acquireLocalAgentStateInstanceLock(state, { pid: 41004, token: 'd'.repeat(32), isProcessAlive: () => false }),
    (error: any) => error?.code === 'LOCAL_AGENT_STATE_LOCK_INVALID'
  );
});

test('release never removes a lock that has been replaced by another owner', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-instance-lock-owner-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const lock = await acquireLocalAgentStateInstanceLock(state, { pid: 41005, token: 'e'.repeat(32), isProcessAlive: () => true });
  await fs.writeFile(path.join(state, 'local-agent.lock'), JSON.stringify({
    version: 1, pid: 41006, token: 'f'.repeat(32), createdAt: '2026-09-29T00:00:00.000Z'
  }));
  await lock.release();
  const stored = JSON.parse(await fs.readFile(path.join(state, 'local-agent.lock'), 'utf8'));
  assert.equal(stored.pid, 41006);
  assert.equal(stored.token, 'f'.repeat(32));
});

test('local-agent state lock reclaims a reused PID whose process creation identity changed', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-instance-lock-pid-reuse-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  await fs.writeFile(path.join(state, 'local-agent.lock'), JSON.stringify({
    version: 2,
    pid: 41007,
    processInstance: { pid: 41007, started: 'old-process-instance' },
    token: 'g'.repeat(32),
    createdAt: '2026-09-29T00:00:00.000Z'
  }));

  const lock = await acquireLocalAgentStateInstanceLock(state, {
    pid: 41008,
    processInstance: { pid: 41008, started: 'new-owner' },
    token: 'h'.repeat(32),
    inspectProcessInstance: async (pid) => pid === 41007 ? { pid, started: 'reused-process-instance' } : null
  });
  const stored = JSON.parse(await fs.readFile(path.join(state, 'local-agent.lock'), 'utf8'));
  assert.equal(stored.pid, 41008);
  assert.equal(stored.processInstance.started, 'new-owner');
  await lock.release();
});
