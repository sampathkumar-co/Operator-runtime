import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EmbeddedControlPlaneStore } from '../src/core/control-plane-store.ts';
import { RemoteAuthorityFenceStore } from '../src/core/remote-authority-fence.ts';

for (const kind of ['revoked', 'released', 'active'] as const) {
  test('persisted ' + kind + ' authority must reject non-number generation without weakening its fence', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-remote-generation-type-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const store = new EmbeddedControlPlaneStore(dir);
    const subject = { accountId: crypto.randomUUID(), deviceId: crypto.randomUUID(), authorityGeneration: 17 };
    const client = new RemoteAuthorityFenceStore(store, { authorize: async () => {} });
    const key = subject.deviceId;
    let record;
    if (kind === 'active') {
      const lease = await client.acquire(subject, 'original-owner');
      const existing = await store.get('__mecord_remote_authority', key);
      record = await store.transact([{ namespace: '__mecord_remote_authority', key,
        expectedGeneration: existing!.generation, value: { ...existing!.value, authorityGeneration: true },
        expiresAt: existing!.expiresAt }]);
      await assert.rejects(client.assertCurrent({ ...lease, generation: record[0]!.generation }),
        (error: any) => error?.code === 'REMOTE_AUTHORITY_CORRUPT');
    } else {
      await store.transact([{ namespace: '__mecord_remote_authority', key, expectedGeneration: null,
        value: { kind, schemaVersion: 1, accountId: subject.accountId, deviceId: subject.deviceId,
          ...(kind === 'revoked' ? { revokedGeneration: true } : { authorityGeneration: true }) } }]);
      const other = { ...subject, accountId: crypto.randomUUID(), authorityGeneration: 2 };
      await assert.rejects(client.acquire(other, 'other-account'),
        (error: any) => error?.code === 'REMOTE_AUTHORITY_CORRUPT');
      assert.equal((await store.get('__mecord_remote_authority', key))!.value.kind, kind);
    }
  });
}
