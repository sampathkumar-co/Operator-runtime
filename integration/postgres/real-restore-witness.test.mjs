import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { canonicalJson } from '../../src/core/action-identity.ts';
import { EmbeddedControlPlaneStore, PostgresControlPlaneStore } from '../../src/core/control-plane-store.ts';
import { restoreControlPlaneWithSignedWitness } from '../../src/core/control-plane-restore-witness.ts';

if (process.env.OPERATOR_REAL_PG_TEST !== '1') {
  test('PostgreSQL restore witness requires ephemeral test database', { skip: true }, () => {});
} else {
  if (process.env.PGDATABASE !== 'operator_test') throw new Error('Refusing restore witness tests outside operator_test');
  const { Pool } = pg;
  const pool = new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'operator_test',
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    max: 8
  });
  const store = new PostgresControlPlaneStore(pool);
  test.before(async () => { await store.initialize(); });
  test.beforeEach(async () => { await pool.query('DROP TABLE IF EXISTS mecord_control_plane');
    await store.initialize(); });
  test.after(async () => { await pool.end(); });

  test('PostgreSQL restore rejects a superseded signed snapshot and retains deleted-key fences on latest approval', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-pg-restore-witness-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const source = new EmbeddedControlPlaneStore(dir);
    const [first] = await source.transact([
      { namespace: 'account', key: 'rebound', expectedGeneration: null, value: { owner: 'old' } }
    ], '2026-10-09T11:01:00.000Z');
    const oldSnapshot = await source.snapshot('2026-10-09T11:02:00.000Z');
    await source.transact([
      { namespace: 'account', key: 'rebound', expectedGeneration: first.generation, value: null }
    ], '2026-10-09T11:03:00.000Z');
    const newSnapshot = await source.snapshot('2026-10-09T11:04:00.000Z');
    assert.equal(newSnapshot.tombstones?.[0]?.generation, 1);
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const sign = (epoch, snapshotDigest) => {
      const manifest = {
        schemaVersion: 1, anchorId: 'trusted-separate-epoch-store',
        epoch, snapshotDigest, issuedAt: '2026-10-09T11:59:00.000Z',
        expiresAt: '2026-10-09T12:09:00.000Z'
      };
      return { manifest, signature: crypto.sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString('base64url') };
    };
    const historical = sign(1, oldSnapshot.digest);
    const latest = sign(2, newSnapshot.digest);
    const guard = {
      anchorId: 'trusted-separate-epoch-store',
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      clock: () => new Date('2026-10-09T12:00:00.000Z'),
      authorizeRestore: async () => {},
      anchor: { withLatestExclusive: async (fn) => await fn(latest) }
    };
    // Even though the historical manifest is correctly signed, it is not
    // the currently anchored monotonic epoch and must never permit rollback.
    assert.ok(crypto.verify(null, Buffer.from(canonicalJson(historical.manifest)), publicKey,
      Buffer.from(historical.signature, 'base64url')));
    await assert.rejects(restoreControlPlaneWithSignedWitness(store, oldSnapshot, guard),
      e => e?.code === 'CONTROL_PLANE_RESTORE_WITNESS_STALE');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM mecord_control_plane')).rows[0].count, 0);
    await restoreControlPlaneWithSignedWitness(store, newSnapshot, guard);
    const hidden = await pool.query(
      'SELECT generation,is_deleted FROM mecord_control_plane WHERE namespace=$1 AND record_key=$2',
      ['account','rebound']
    );
    assert.equal(Number(hidden.rows[0].generation), 1);
    assert.equal(hidden.rows[0].is_deleted, true);
    const [recreated] = await store.transact([
      { namespace: 'account', key: 'rebound', expectedGeneration: null, value: { owner: 'new' } }
    ], '2026-10-09T12:01:00.000Z');
    assert.equal(recreated.generation, 2);
    await assert.rejects(store.transact([
      { namespace: 'account', key: 'rebound', expectedGeneration: 1, value: { owner: 'replayed' } }
    ], '2026-10-09T12:02:00.000Z'), e => e?.code === 'CONTROL_PLANE_CAS_MISMATCH');
  });
}
