import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withDurableStateLock } from '../src/core/durable-state-lock.ts';
import { currentProcessInstance, localPidObservationAdmissible } from '../src/core/process-instance.ts';

const BOOT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOOT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('cross-host Linux boot identity forbids local PID-based stale file-lock eviction', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-cross-host-lock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'durable-state.json');
  const lockFile = stateFile + '.lock';
  const local = await currentProcessInstance();
  const remoteBoot = local.started.includes(BOOT_A) ? BOOT_B : BOOT_A;
  const remote = {
    token: '77777777-7777-4777-8777-777777777777',
    processInstance: {
      // Deliberate collision: local PID observer reports this very live process
      // while the stored owner identity is from a different Linux boot.
      pid: process.pid,
      started: 'linux-boot-id:' + remoteBoot + ':ticks:1234'
    }
  };
  await fs.writeFile(lockFile, JSON.stringify(remote));
  let entered = false;
  await assert.rejects(
    () => withDurableStateLock(stateFile, async () => { entered = true; }),
    (error: any) => error?.code === 'DURABLE_STATE_LOCK_BUSY'
  );
  assert.equal(entered, false);
  assert.deepEqual(JSON.parse(await fs.readFile(lockFile, 'utf8')), remote);
});

test('Linux PID recovery scope only accepts exact current boot evidence', async () => {
  const local = { pid: 100, started: 'linux-boot-id:' + BOOT_A + ':ticks:1000' };
  assert.equal(localPidObservationAdmissible(
    { pid: 200, started: 'linux-boot-id:' + BOOT_A + ':ticks:2000' }, local), true);
  assert.equal(localPidObservationAdmissible(
    { pid: 200, started: 'linux-boot-id:' + BOOT_B + ':ticks:2000' }, local), false);
  assert.equal(localPidObservationAdmissible(
    { pid: 200, started: 'linux-boot-ticks:2000' }, local), false);
  assert.equal(localPidObservationAdmissible(undefined, local), false);
});

test('same-boot dead Linux lock owner can be reclaimed without remote-host override', async t => {
  const local = await currentProcessInstance();
  const match = /^linux-boot-id:([0-9a-f-]{36}):ticks:\d+$/.exec(local.started);
  if (!match) { t.skip('only Linux exposes a verified boot ID and local PID absence'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-local-lock-recovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'durable-state.json');
  await fs.writeFile(stateFile + '.lock', JSON.stringify({
    token: '88888888-8888-4888-8888-888888888888',
    processInstance: {
      pid: 2147483646,
      started: 'linux-boot-id:' + match[1] + ':ticks:100'
    }
  }));
  let entered = false;
  await withDurableStateLock(stateFile, async () => { entered = true; });
  assert.equal(entered, true);
  await assert.rejects(fs.stat(stateFile + '.lock'), (error: any) => error?.code === 'ENOENT');
});
