import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {
  PostgresControlPlaneStore,
  applyControlPlaneMigration,
  purgeExpiredControlPlaneRecords
} from '../../src/core/control-plane-store.ts';

const { Pool } = pg;
if (process.env.OPERATOR_REAL_PG_TEST !== '1') {
  test('real PostgreSQL integration requires an explicitly ephemeral test database', { skip: true }, () => {});
} else {
  const pool = new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'operator_test',
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE ?? 'operator_test',
    max: 16,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 5_000
  });
  const store = new PostgresControlPlaneStore(pool);
  test.before(async () => {
    if (process.env.PGDATABASE !== 'operator_test') {
      throw new Error('Refusing destructive integration tests outside operator_test database');
    }
    await store.initialize();
  });
  test.beforeEach(async () => {
    await pool.query('TRUNCATE TABLE mecord_control_plane');
  });
  test.after(async () => {
    await pool.end();
  });

  test('two real pooled clients race on absent-key CAS; exactly one can create', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        store.transact([{
          namespace: 'leases', key: 'device:test', expectedGeneration: null,
          value: { owner: 'relay-' + i }
        }], '2026-10-08T00:00:01.000Z'))
    );
    const won = attempts.filter(item => item.status === 'fulfilled');
    const lost = attempts.filter(item => item.status === 'rejected');
    assert.equal(won.length, 1);
    assert.equal(lost.length, 11);
    for (const result of lost) {
      assert.equal(result.reason?.code, 'CONTROL_PLANE_CAS_MISMATCH');
    }
    assert.equal((await store.get('leases', 'device:test'))?.generation, 1);
  });

  test('expired keys preserve fencing generation across actual row update', async () => {
    const [one] = await store.transact([{
      namespace: 'leases', key: 'fence', expectedGeneration: null,
      value: { owner: 'one' }, expiresAt: '2026-10-08T00:00:05.000Z'
    }], '2026-10-08T00:00:01.000Z');
    assert.equal(one?.generation, 1);
    const [two] = await store.transact([{
      namespace: 'leases', key: 'fence', expectedGeneration: null,
      value: { owner: 'two' }, expiresAt: '2026-10-08T00:01:00.000Z'
    }], '2026-10-08T00:00:10.000Z');
    assert.equal(two?.generation, 2);
    assert.equal((await store.get('leases', 'fence'))?.value.owner, 'two');
    await assert.rejects(
      store.transact([{
        namespace: 'leases', key: 'fence', expectedGeneration: 1,
        value: { owner: 'stale' }
      }], '2026-10-08T00:00:11.000Z'),
      (error) => error?.code === 'CONTROL_PLANE_CAS_MISMATCH'
    );
  });

  test('multi-record transaction rolls back all changes on a later CAS conflict', async () => {
    await store.transact([{
      namespace: 'config', key: 'b', expectedGeneration: null, value: { value: 'initial' }
    }], '2026-10-08T00:00:01.000Z');
    await assert.rejects(
      store.transact([
        { namespace: 'config', key: 'a', expectedGeneration: null, value: { value: 'partial' } },
        { namespace: 'config', key: 'b', expectedGeneration: null, value: { value: 'invalid' } }
      ], '2026-10-08T00:00:02.000Z'),
      (error) => error?.code === 'CONTROL_PLANE_CAS_MISMATCH'
    );
    assert.equal(await store.get('config', 'a'), null);
    assert.equal((await store.get('config', 'b'))?.value.value, 'initial');
  });

  test('two real migrators converge to one durable marker', async () => {
    const migration = { id: 'live-race', mutations: [
      { namespace: 'settings', key: 'feature', expectedGeneration: null, value: { enabled: true } }
    ] };
    const results = await Promise.all([
      applyControlPlaneMigration(store, migration, '2026-10-08T00:00:01.000Z'),
      applyControlPlaneMigration(store, migration, '2026-10-08T00:00:01.000Z')
    ]);
    assert.deepEqual([...results].sort(), [false, true]);
    assert.equal((await store.get('settings', 'feature'))?.generation, 1);
  });

  test('actual snapshot restore rejects overwrite and validates restored bytes', async () => {
    await store.transact([{
      namespace: 'proof', key: 'receipt', expectedGeneration: null,
      value: { verified: true, cohort: 2 }
    }], '2026-10-08T00:00:01.000Z');
    const snapshot = await store.snapshot('2026-10-08T00:00:02.000Z');
    await assert.rejects(store.restore(snapshot),
      (error) => error?.code === 'CONTROL_PLANE_RESTORE_CONFLICT');
    await pool.query('TRUNCATE TABLE mecord_control_plane');
    await store.restore(snapshot);
    assert.deepEqual((await store.get('proof', 'receipt'))?.value, { cohort: 2, verified: true });
    await assert.rejects(store.restore(snapshot),
      (error) => error?.code === 'CONTROL_PLANE_RESTORE_CONFLICT');
  });
  test('real PostgreSQL delete and expiry purge never recycle a CAS generation', async () => {
    const [first] = await store.transact([{
      namespace: 'leases', key: 'aba-key', expectedGeneration: null, value: { owner: 'first' }
    }], '2026-10-08T00:00:01.000Z');
    assert.equal(first?.generation, 1);

    await store.transact([{
      namespace: 'leases', key: 'aba-key', expectedGeneration: first.generation, value: null
    }], '2026-10-08T00:00:02.000Z');
    assert.equal(await store.get('leases', 'aba-key'), null);
    assert.equal((await store.list('leases')).length, 0);
    const hidden = await pool.query(
      'SELECT generation, is_deleted FROM mecord_control_plane WHERE namespace=$1 AND record_key=$2',
      ['leases', 'aba-key']
    );
    assert.equal(Number(hidden.rows[0]?.generation), 1);
    assert.equal(hidden.rows[0]?.is_deleted, true);
    assert.equal((await store.snapshot('2026-10-08T00:00:03.000Z')).records.length, 0);

    const [second] = await store.transact([{
      namespace: 'leases', key: 'aba-key', expectedGeneration: null, value: { owner: 'second' }
    }], '2026-10-08T00:00:04.000Z');
    assert.equal(second?.generation, 2);
    await assert.rejects(
      store.transact([{
        namespace: 'leases', key: 'aba-key', expectedGeneration: first.generation,
        value: { owner: 'stale' }
      }], '2026-10-08T00:00:05.000Z'),
      error => error?.code === 'CONTROL_PLANE_CAS_MISMATCH'
    );
    assert.equal((await store.get('leases', 'aba-key'))?.value.owner, 'second');

    const [expiring] = await store.transact([{
      namespace: 'leases', key: 'expiring-key', expectedGeneration: null,
      value: { owner: 'old' }, expiresAt: '2026-10-08T00:00:10.000Z'
    }], '2026-10-08T00:00:06.000Z');
    assert.equal(await purgeExpiredControlPlaneRecords(store, 'leases', '2026-10-08T00:00:11.000Z'), 1);
    assert.equal(await store.get('leases', 'expiring-key'), null);
    const [renewed] = await store.transact([{
      namespace: 'leases', key: 'expiring-key', expectedGeneration: null, value: { owner: 'new' }
    }], '2026-10-08T00:00:12.000Z');
    assert.ok(renewed.generation > expiring.generation);
    await assert.rejects(
      store.transact([{
        namespace: 'leases', key: 'expiring-key', expectedGeneration: expiring.generation,
        value: { owner: 'stale' }
      }], '2026-10-08T00:00:13.000Z'),
      error => error?.code === 'CONTROL_PLANE_CAS_MISMATCH'
    );
    assert.equal((await store.get('leases', 'expiring-key'))?.value.owner, 'new');
  });

  test('database trigger fences old workers that physically delete or recycle control-plane generations', async () => {
    const [first] = await store.transact([{
      namespace: 'authority', key: 'legacy-worker-key', expectedGeneration: null,
      value: { owner: 'new-runtime' }
    }], '2026-10-09T00:00:01.000Z');
    assert.equal(first.generation, 1);

    // This is the old binary's DELETE path. It must fail at the shared DB
    // even if that worker is unaware of v2 tombstones and no other process
    // is concurrently holding the key advisory lock.
    await assert.rejects(
      pool.query('DELETE FROM mecord_control_plane WHERE namespace=$1 AND record_key=$2',
        ['authority', 'legacy-worker-key']),
      error => error?.code === '23514' && /LEGACY_DELETE_FENCED/.test(error.message)
    );
    assert.equal((await store.get('authority','legacy-worker-key'))?.generation, 1);

    await assert.rejects(
      pool.query(`UPDATE mecord_control_plane SET generation=0,
        value_json='{"owner":"old"}'::jsonb
        WHERE namespace=$1 AND record_key=$2`, ['authority', 'legacy-worker-key']),
      error => error?.code === '23514' && /LEGACY_GENERATION_FENCED/.test(error.message)
    );
    await assert.rejects(
      pool.query(`UPDATE mecord_control_plane SET generation=1,
        value_json='{"owner":"old"}'::jsonb
        WHERE namespace=$1 AND record_key=$2`, ['authority', 'legacy-worker-key']),
      error => error?.code === '23514' && /LEGACY_GENERATION_FENCED/.test(error.message)
    );

    await store.transact([{
      namespace: 'authority', key: 'legacy-worker-key', expectedGeneration: first.generation, value: null
    }], '2026-10-09T00:00:02.000Z');
    await assert.rejects(
      pool.query(`INSERT INTO mecord_control_plane(namespace,record_key,generation,value_digest,value_json,updated_at,expires_at)
        VALUES('authority','legacy-worker-key',1,$1::text,'{"owner":"old"}'::jsonb,NOW(),NULL)
        ON CONFLICT(namespace,record_key) DO UPDATE SET
        generation=EXCLUDED.generation,value_json=EXCLUDED.value_json`,
      ['0'.repeat(64)]),
      error => error?.code === '23514' && /LEGACY_GENERATION_FENCED/.test(error.message)
    );
    const [reincarnation] = await store.transact([{
      namespace: 'authority', key: 'legacy-worker-key', expectedGeneration: null,
      value: { owner: 'new-owner' }
    }], '2026-10-09T00:00:03.000Z');
    assert.equal(reincarnation.generation, 2);
    assert.equal((await store.get('authority','legacy-worker-key'))?.value.owner, 'new-owner');
  });

}
