import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EmbeddedControlPlaneStore } from '../src/core/control-plane-store.ts';
import { RemoteAuthorityFenceStore } from '../src/core/remote-authority-fence.ts';

test('C08 missing active lease expiry must not let a second host seize the device generation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-c08-lease-expiry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = new EmbeddedControlPlaneStore(root);
  const time = '2026-10-09T00:00:00.000Z';
  const subject = {
    accountId: crypto.randomUUID(), deviceId: crypto.randomUUID(), authorityGeneration: 1
  };
  const client = () => new RemoteAuthorityFenceStore(new EmbeddedControlPlaneStore(root), {
    authorize: async () => {}, clock: () => new Date(time)
  });
  await client().acquire(subject, 'trusted-original-owner', 30_000);
  const current = (await state.get('__mecord_remote_authority', subject.deviceId))!;
  assert.equal(current.value.kind, 'active');
  assert.ok(current.expiresAt);
  // A restore, migration or competing writer may leave a syntactically valid
  // active CAS record without a TTL. Its status is unknown, not 'expired'.
  await state.transact([{
    namespace: '__mecord_remote_authority', key: subject.deviceId,
    expectedGeneration: current.generation, value: current.value
  }], time);
  const compromised = (await state.get('__mecord_remote_authority', subject.deviceId))!;
  assert.equal(compromised.expiresAt, undefined);
  await assert.rejects(client().acquire(subject, 'opportunistic-new-owner', 30_000),
    (e: any) => e?.code === 'REMOTE_AUTHORITY_CORRUPT');
  const unchanged = (await state.get('__mecord_remote_authority', subject.deviceId))!;
  assert.equal(unchanged.generation, compromised.generation);
  assert.equal(unchanged.value.ownerId, 'trusted-original-owner');
});
