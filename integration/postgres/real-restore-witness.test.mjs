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
import { PostgresExternalRestoreAnchor } from '../../src/core/postgres-external-restore-anchor.ts';

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

  test('PostgreSQL witness-bound store forbids direct restore and permits only pinned-current approval', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-witness-guarded-postgres-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = new EmbeddedControlPlaneStore(root);
    await source.transact([{ namespace:'safety', key:'replay', expectedGeneration:null,
      value:{owner:'initial'} }], '2026-10-09T11:01:00.000Z');
    const snapshot = await source.snapshot('2026-10-09T11:03:00.000Z');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const manifest = { schemaVersion:1, anchorId:'independent-approval',
      epoch:5, snapshotDigest:snapshot.digest,
      issuedAt:'2026-10-09T11:59:00.000Z', expiresAt:'2026-10-09T12:09:00.000Z' };
    const guard = {
      anchorId:manifest.anchorId,
      publicKeyPem: publicKey.export({ format:'pem', type:'spki' }).toString(),
      clock: () => new Date('2026-10-09T12:00:00.000Z'),
      authorizeRestore: async () => {},
      anchor: { withLatestExclusive: async (fn) => await fn({
        manifest, signature: crypto.sign(null,Buffer.from(canonicalJson(manifest)),privateKey).toString('base64url')
      }) }
    };
    assert.throws(() => new PostgresControlPlaneStore(pool,{requireWitnessForRestore:true}),
      e => e?.code === 'CONTROL_PLANE_RESTORE_WITNESS_REQUIRED');
    const guarded = new PostgresControlPlaneStore(pool,{
      restoreGuard:guard, requireWitnessForRestore:true
    });
    await assert.rejects(guarded.restore(snapshot),
      e => e?.code === 'CONTROL_PLANE_RESTORE_WITNESS_REQUIRED');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM mecord_control_plane')).rows[0].count,0);
    await guarded.restoreWithConfiguredWitness(snapshot);
    assert.equal((await guarded.get('safety','replay'))?.value.owner,'initial');
    await assert.rejects(guarded.restoreWithConfiguredWitness(snapshot),
      e => e?.code === 'CONTROL_PLANE_RESTORE_CONFLICT');
  });
  test('real PostgreSQL externally pinned witness authorizes the latest signed restore', async t => {
    // This test checks PostgreSQL row locks and signed-restore integration.
    // Production must use a DIFFERENT witness DB/backup/administrator domain.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-external-restore-pg-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const source = new EmbeddedControlPlaneStore(dir);
    await source.transact([{ namespace: 'recovered', key: 'device', expectedGeneration: null,
      value: { authorityGeneration: 4 } }], '2026-10-09T11:01:00.000Z');
    const snapshot = await source.snapshot('2026-10-09T11:02:00.000Z');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const anchorId = 'witness-test-' + crypto.randomUUID();
    const manifest = {
      schemaVersion: 1, anchorId, epoch: 7, snapshotDigest: snapshot.digest,
      issuedAt: '2026-10-09T11:59:00.000Z', expiresAt: '2026-10-09T12:09:00.000Z'
    };
    const signature = crypto.sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString('base64url');
    // Operate the witness routine with a separate SELECT/EXECUTE-only
    // principal, not the privileged publisher account used in earlier tests.
    const witnessSetup = await fs.readFile(
      new URL('../../deploy/postgres/external-restore-witness-reader.sql', import.meta.url), 'utf8');
    await pool.query(witnessSetup);
    await pool.query(
      'INSERT INTO public.mecord_restore_witness_anchor(anchor_id,signed_manifest,signature) VALUES($1,$2::jsonb,$3)',
      [anchorId, JSON.stringify(manifest), signature]);
    const role = 'witness_reader_ci_' + crypto.randomBytes(6).toString('hex');
    const readerPassword = crypto.randomBytes(20).toString('base64url');
    await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${readerPassword}'`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await pool.query(`GRANT EXECUTE ON FUNCTION public.mecord_restore_witness_lock_read(TEXT) TO ${role}`);
    const readerPool = new Pool({
      host: process.env.PGHOST ?? '127.0.0.1',
      port: Number(process.env.PGPORT ?? 5432),
      user: role, password: readerPassword, database: process.env.PGDATABASE,
      max: 2, connectionTimeoutMillis: 10_000
    });
    t.after(async () => {
      await readerPool.end();
      await pool.query(`REVOKE EXECUTE ON FUNCTION public.mecord_restore_witness_lock_read(TEXT) FROM ${role}`);
      await pool.query(`REVOKE USAGE ON SCHEMA public FROM ${role}`);
      await pool.query(`DROP ROLE ${role}`);
    });
    const permissions = await readerPool.query(
      "SELECT has_table_privilege(current_user, 'public.mecord_restore_witness_anchor', 'UPDATE') AS can_update");
    assert.equal(permissions.rows[0].can_update, false);
    await assert.rejects(readerPool.query(
      'SELECT anchor_id FROM public.mecord_restore_witness_anchor WHERE anchor_id=$1 FOR UPDATE', [anchorId]),
      e => e?.code === '42501');
    const guard = {
      anchorId,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      clock: () => new Date('2026-10-09T12:00:00.000Z'),
      authorizeRestore: async () => {},
      anchor: new PostgresExternalRestoreAnchor(readerPool, anchorId)
    };
    const guardedStore = new PostgresControlPlaneStore(pool, { restoreGuard: guard, requireWitnessForRestore: true });
    await assert.rejects(guardedStore.restore(snapshot),
      e => e?.code === 'CONTROL_PLANE_RESTORE_WITNESS_REQUIRED');
    await guardedStore.restoreWithConfiguredWitness(snapshot);
    assert.equal((await guardedStore.get('recovered', 'device'))?.value.authorityGeneration, 4);
    // An independent publisher's UPDATE must be unable to advance the
    // witness while the trusted restore callback holds its row lock.
    let entered, resume;
    const inside = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { resume = resolve; });
    const witnessRead = guard.anchor.withLatestExclusive(async latest => {
      assert.equal(latest.manifest.epoch, 7);
      entered();
      await hold;
    });
    await inside;
    const rival = await pool.connect();
    try {
      await rival.query('SET statement_timeout = 750');
      await assert.rejects(rival.query(
        'UPDATE mecord_restore_witness_anchor SET signature=$2 WHERE anchor_id=$1',
        [anchorId, signature]),
        e => e?.code === '57014');
      await rival.query('SET statement_timeout = 0');
    } finally {
      rival.release();
      resume();
      await witnessRead;
    }
    // A signed stale latest-witness row rejects a different snapshot, even
    // though the target already contains data and both DBs are reachable.
    const stale = { ...snapshot, digest: '0'.repeat(64) };
    await assert.rejects(guardedStore.restoreWithConfiguredWitness(stale),
      e => e?.code === 'CONTROL_PLANE_RESTORE_WITNESS_STALE');
  });

}
