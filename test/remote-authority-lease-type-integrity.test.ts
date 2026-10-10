import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EmbeddedControlPlaneStore } from '../src/core/control-plane-store.ts';
import { RemoteAuthorityFenceStore } from '../src/core/remote-authority-fence.ts';
import { validProcessInstance } from '../src/core/process-instance.ts';

test('process instance refuses coerced PIDs used in durable recovery tokens', () => {
  const started = 'test-process-start';
  assert.deepEqual(validProcessInstance({pid: 3456, started}), {pid: 3456, started});
  for (const pid of ['3456', [3456], true, [1]]) {
    assert.equal(validProcessInstance({pid, started}), null);
  }
});

test('authority operations cannot retarget device/tenant identities through JSON arrays', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-lease-envelope-types-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const calls: string[] = [];
  const subject = {accountId: crypto.randomUUID(), deviceId: crypto.randomUUID(), authorityGeneration: 1};
  const store = new RemoteAuthorityFenceStore(new EmbeddedControlPlaneStore(dir), {
    authorize: async (_, mode) => {calls.push(mode);},
  });
  const lease = await store.acquire(subject, 'trusted-owner');
  await store.assertCurrent(lease);
  const before = calls.length;
  for (const malformed of [
    {...subject, accountId: [subject.accountId]},
    {...subject, deviceId: [subject.deviceId]}
  ]) {
    await assert.rejects(store.revoke(malformed as any),
      (error: any) => error?.code === 'REMOTE_AUTHORITY_INVALID');
  }
  assert.equal(calls.length, before, 'invalid identities must not reach the authorization provider');
  for (const malformed of [
    {...lease, accountId: [lease.accountId]},
    {...lease, deviceId: [lease.deviceId]},
    {...lease, leaseId: [lease.leaseId]},
    {...lease, fenceToken: [lease.fenceToken]},
    {...lease, expiresAt: [lease.expiresAt]},
    {...lease, process: {...lease.process, pid: String(lease.process.pid)}},
  ]) {
    await assert.rejects(store.assertCurrent(malformed as any),
      (error: any) => error?.code === 'REMOTE_AUTHORITY_INVALID');
  }
  assert.equal((await store.assertCurrent(lease)).leaseId, lease.leaseId);
});
