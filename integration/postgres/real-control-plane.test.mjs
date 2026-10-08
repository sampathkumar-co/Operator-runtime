import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {
  PostgresControlPlaneStore,
  applyControlPlaneMigration
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
}
