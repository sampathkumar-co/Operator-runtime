// Explicit, disposable PostgreSQL 18 integration certification: never connect to production.
// CI supplies a temporary PostgreSQL service. Locally run against an isolated sandbox cluster.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { PostgresControlPlaneStore, purgeExpiredControlPlaneRecords } from '../src/core/control-plane-store.ts';
const driver = process.env.MECORD_TEST_PG_MODULE;
const port = Number(process.env.MECORD_TEST_PG_PORT);
if (!driver || !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('A dedicated sandbox driver and port are required. Refusing ambiguous database connection.');
}
const pg = (await import(pathToFileURL(driver).href)).default;
const pool = new pg.Pool({
  host: '127.0.0.1', port, user: 'mecord_cert', database: 'postgres',
  ...(process.env.MECORD_TEST_PG_PASSWORD ? { password: process.env.MECORD_TEST_PG_PASSWORD } : {}),
  max: 8, connectionTimeoutMillis: 4000
});
const s1 = new PostgresControlPlaneStore(pool);
const s2 = new PostgresControlPlaneStore(pool);
function mutation(key, expectedGeneration, value, expiresAt) {
  return [{ namespace: 'cas_cert', key, expectedGeneration, value, ...(expiresAt ? { expiresAt } : {}) }];
}
async function expectCas(run) {
  await assert.rejects(run, (error) => error?.code === 'CONTROL_PLANE_CAS_MISMATCH');
}
try {
  await s1.initialize();
  let records = await s1.transact(mutation('key', null, { owner: 'first' }));
  assert.equal(records[0].generation, 1);
  await s2.transact(mutation('key', 1, null));
  assert.equal(await s1.get('cas_cert', 'key'), null);
  records = await s2.transact(mutation('key', null, { owner: 'second' }));
  assert.equal(records[0].generation, 2);
  await expectCas(() => s1.transact(mutation('key', 1, { owner: 'stale' })));
  assert.equal((await s1.get('cas_cert', 'key')).value.owner, 'second');

  const expired = '2020-01-01T00:00:00.000Z';
  const now = '2026-10-11T03:00:00.000Z';
  records = await s1.transact(mutation('expired', null, { owner: 'old' }, expired), now);
  assert.equal(records[0].generation, 1);
  records = await s2.transact(mutation('expired', null, { owner: 'new' }), now);
  assert.equal(records[0].generation, 2);
  await expectCas(() => s1.transact(mutation('expired', 1, { owner: 'stale' }), now));

  // #192: the separate retention path must preserve the same immutable
  // incarnation fence as explicit deletion. A different store instance
  // performs purge, then a third one attempts a stale-generation write.
  const purgeNamespace = 'cas_purge_cert';
  const purgeKey = 'expired-then-recreated';
  const [beforePurge] = await s1.transact([{
    namespace: purgeNamespace, key: purgeKey, expectedGeneration: null,
    value: { owner: 'before-purge' }, expiresAt: expired
  }], now);
  assert.equal(beforePurge.generation, 1);
  const removed = await purgeExpiredControlPlaneRecords(s2, purgeNamespace, now);
  assert.equal(removed, 1, 'the expired row must actually be purged');
  assert.equal(await s1.get(purgeNamespace, purgeKey), null);
  const afterPurgeSnapshot = await s1.snapshot(now);
  assert.ok(afterPurgeSnapshot.tombstones.some(fence =>
    fence.namespace === purgeNamespace && fence.key === purgeKey && fence.generation === 1));
  const [afterPurge] = await s2.transact([{
    namespace: purgeNamespace, key: purgeKey, expectedGeneration: null,
    value: { owner: 'after-purge' }
  }], now);
  assert.equal(afterPurge.generation, 2, 'retention purge must never recycle generation one');
  await expectCas(() => new PostgresControlPlaneStore(pool).transact([{
    namespace: purgeNamespace, key: purgeKey, expectedGeneration: 1,
    value: { owner: 'stale-before-purge' }
  }], now));
  assert.equal((await s1.get(purgeNamespace, purgeKey)).value.owner, 'after-purge');


  const races = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
    new PostgresControlPlaneStore(pool).transact(mutation('concurrent', null, { index: i }), now)));
  const accepted = races.filter((r) => r.status === 'fulfilled');
  const denied = races.filter((r) => r.status === 'rejected' && r.reason?.code === 'CONTROL_PLANE_CAS_MISMATCH');
  assert.equal(accepted.length, 1);
  assert.equal(denied.length, 7);

  await s1.transact(mutation('deleted', null, { owner: 'prior' }), now);
  await s2.transact(mutation('deleted', 1, null), now);
  const snapshot = await s1.snapshot(now);
  assert.ok(snapshot.tombstones.some((t) =>
    t.namespace === 'cas_cert' && t.key === 'deleted' && t.generation === 1));

  const client = await pool.connect();
  try {
    await assert.rejects(
      client.query("DELETE FROM mecord_control_plane WHERE namespace='cas_cert' AND record_key='deleted'"),
      (e) => e?.code === '23514');
    await assert.rejects(client.query('TRUNCATE mecord_control_plane'), (e) => e?.code === '23514');
    await assert.rejects(
      client.query("UPDATE mecord_control_plane SET generation=1 WHERE namespace='cas_cert' AND record_key='key'"),
      (e) => e?.code === '23514');
  } finally { client.release(); }
  console.log('LIVE_POSTGRES_CAS_CERT_PASS', JSON.stringify({
    generationAfterDelete: 2, generationAfterExpiry: 2, staleWritesDenied: true,
    concurrentSuccess: accepted.length, concurrentConflicts: denied.length,
    physicalDeletionDenied: true, truncateDenied: true, staleGenerationDenied: true,
    hiddenTombstones: snapshot.tombstones.length
  }));
} finally {
  await pool.end();
}
