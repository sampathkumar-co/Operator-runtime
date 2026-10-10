import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresExternalRestoreAnchor } from '../src/core/postgres-external-restore-anchor.ts';
import type { PostgresQueryHost } from '../src/core/control-plane-store.ts';

const signed = {
  manifest: {
    schemaVersion: 1 as const,
    anchorId: 'external-test',
    epoch: 42,
    snapshotDigest: 'a'.repeat(64),
    issuedAt: '2026-10-10T10:00:00.000Z',
    expiresAt: '2026-10-10T10:05:00.000Z'
  },
  signature: 'test-signature-guard-validates'
};

function fixture(options: { missing?: boolean; malformed?: boolean; rollbackFails?: boolean } = {}) {
  const calls: string[] = [];
  let releasedWith: Error | undefined;
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push(sql);
      if (sql === 'ROLLBACK' && options.rollbackFails) throw new Error('witness link lost');
      if (sql.includes('mecord_restore_witness_lock_read')) {
        assert.deepEqual(values, ['external-test']);
        if (options.missing) return { rows: [] };
        return { rows: [{
          anchor_id: 'external-test',
          signed_manifest: options.malformed ? { ...signed.manifest, anchorId: 'different-owner' } : signed.manifest,
          signature: signed.signature
        }] };
      }
      return { rows: [] };
    },
    release(error?: Error) { releasedWith = error; }
  };
  const db = { connect: async () => client,
    async query() { throw new Error('unbound pool.query must never own the witness transaction'); }
  } as unknown as PostgresQueryHost;
  return { anchor: new PostgresExternalRestoreAnchor(db, 'external-test'), calls,
    releaseError: () => releasedWith, db };
}

test('independent witness pins one exact transaction and holds row lock for entire restore callback', async () => {
  const { anchor, calls, releaseError } = fixture();
  let resume!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const work = anchor.withLatestExclusive(async latest => {
    assert.deepEqual(latest, signed);
    entered();
    await gate;
    return latest.manifest.epoch;
  });
  await reached;
  assert.deepEqual(calls, ['BEGIN',
    'SELECT anchor_id, signed_manifest, signature FROM public.mecord_restore_witness_lock_read($1)']);
  resume();
  assert.equal(await work, 42);
  assert.equal(calls.at(-1), 'COMMIT');
  assert.equal(releaseError(), undefined);
});

test('missing or foreign latest witness fails closed without invoking restore', async () => {
  for (const options of [{ missing: true }, { malformed: true }]) {
    const { anchor, calls } = fixture(options);
    let called = false;
    await assert.rejects(anchor.withLatestExclusive(async () => { called = true; }),
      (error: any) => error?.code === (options.missing
        ? 'CONTROL_PLANE_RESTORE_ANCHOR_UNAVAILABLE'
        : 'CONTROL_PLANE_RESTORE_ANCHOR_INVALID'));
    assert.equal(called, false);
    assert.equal(calls.at(-1), 'ROLLBACK');
  }
});

test('a callback failure rolls back the external authority transaction', async () => {
  const { anchor, calls } = fixture();
  await assert.rejects(anchor.withLatestExclusive(async () => { throw new Error('target restore failed'); }),
    /target restore failed/);
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.equal(calls.includes('COMMIT'), false);
});

test('rollback failure poisons and discards the pinned external authority session', async () => {
  const { anchor, releaseError } = fixture({ rollbackFails: true });
  await assert.rejects(anchor.withLatestExclusive(async () => { throw new Error('target write failed'); }),
    (error: any) => error?.code === 'CONTROL_PLANE_RESTORE_ANCHOR_UNSAFE');
  assert.ok(releaseError() instanceof Error);
});

test('an unpinned direct PostgreSQL client cannot be used as an independent witness', () => {
  assert.throws(() => new PostgresExternalRestoreAnchor({
    async query() { return { rows: [] }; }
  }, 'external-test'), (error: any) => error?.code === 'CONTROL_PLANE_RESTORE_ANCHOR_POOL_REQUIRED');
  const { db } = fixture();
  assert.throws(() => new PostgresExternalRestoreAnchor(db, 'bad anchor with spaces'),
    (error: any) => error?.code === 'CONTROL_PLANE_RESTORE_ANCHOR_INVALID');
});
