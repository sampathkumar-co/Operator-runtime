import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EmbeddedControlPlaneStore } from '../src/core/control-plane-store.ts';
import { RemoteAuthorityFenceStore } from '../src/core/remote-authority-fence.ts';

test('C08 revocation during async account policy check cannot return a stale authority lease', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-c08-policy-fence-race-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const subject = {
    accountId: crypto.randomUUID(), deviceId: crypto.randomUUID(), authorityGeneration: 1
  };
  const current = () => new RemoteAuthorityFenceStore(new EmbeddedControlPlaneStore(dir), {
    authorize: async () => {}
  });
  const lease = await current().acquire(subject, 'trusted-owner');
  let entered!: () => void;
  let permit!: () => void;
  const checking = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { permit = resolve; });
  const delayed = new RemoteAuthorityFenceStore(new EmbeddedControlPlaneStore(dir), {
    authorize: async (_, mode) => {
      if (mode === 'acquire') { entered(); await gate; }
    }
  });
  const assertion = delayed.assertCurrent(lease);
  await checking;
  const barrier = await current().revoke(subject);
  assert.ok(barrier.generation > lease.generation);
  permit();
  await assert.rejects(assertion, (error: any) => error?.code === 'REMOTE_AUTHORITY_FENCE_LOST');
  // Revocation remains monotonic: the old generation can never re-acquire.
  await assert.rejects(current().acquire(subject, 'stale-worker'),
    (error: any) => error?.code === 'REMOTE_AUTHORITY_REVOKED');
});

test('C08 unchanged authority still passes the post-policy recheck', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-c08-policy-no-race-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new RemoteAuthorityFenceStore(new EmbeddedControlPlaneStore(dir), {
    authorize: async () => { await Promise.resolve(); }
  });
  const subject = { accountId: crypto.randomUUID(), deviceId: crypto.randomUUID(),
    authorityGeneration: 1 };
  const lease = await store.acquire(subject, 'trusted-owner');
  const current = await store.assertCurrent(lease);
  assert.equal(current.generation, lease.generation);
  assert.equal(current.leaseId, lease.leaseId);
});
