import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { PostgresControlPlaneStore } from '../../src/core/control-plane-store.ts';
import { RemoteAuthorityFenceStore } from '../../src/core/remote-authority-fence.ts';

const { Pool } = pg;
if (process.env.OPERATOR_REAL_PG_TEST !== '1') {
  test('real PostgreSQL authority invariants require ephemeral database', { skip: true }, () => {});
} else {
  if (process.env.PGDATABASE !== 'operator_test') {
    throw new Error('Refusing authority fault tests outside operator_test database');
  }
  const connect = () => new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'operator_test',
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    max: 8, connectionTimeoutMillis: 10_000
  });
  const firstPool = connect();
  const secondPool = connect();
  const firstStore = new PostgresControlPlaneStore(firstPool);
  const secondStore = new PostgresControlPlaneStore(secondPool);
  const authorize = async () => {};
  const authorizeMutation = async (_subject, mutation) => {
    if (mutation.namespace !== 'provider-effects') throw new Error('protected effect scope denied');
  };
  const fence = (store) => new RemoteAuthorityFenceStore(store, { authorize, authorizeMutation });
  const subject = () => ({
    accountId: crypto.randomUUID(), deviceId: crypto.randomUUID(), authorityGeneration: 1
  });
  test.before(async () => { await firstStore.initialize(); });
  test.beforeEach(async () => { await firstPool.query('DROP TABLE IF EXISTS mecord_control_plane');
    await firstStore.initialize(); });
  test.after(async () => { await Promise.all([firstPool.end(), secondPool.end()]); });

  test('independent PostgreSQL hosts cannot both commit the same live authority lease', async () => {
    const who = subject();
    const results = await Promise.allSettled([
      fence(firstStore).acquire(who, 'host-one'),
      fence(secondStore).acquire(who, 'host-two')
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const owner = results.find(r => r.status === 'fulfilled').value;
    assert.equal((await fence(secondStore).assertCurrent(owner)).ownerId, owner.ownerId);
  });

  test('PostgreSQL rolls back a delayed effect if another connection revokes the owner', async () => {
    const who = subject();
    const issued = await fence(firstStore).acquire(who, 'effect-host');
    let entered;
    const pause = new Promise(resolve => { entered = resolve; });
    let resume;
    const barrier = new Promise(resolve => { resume = resolve; });
    const delayed = {
      get: firstStore.get.bind(firstStore),
      list: firstStore.list.bind(firstStore),
      snapshot: firstStore.snapshot.bind(firstStore),
      restore: firstStore.restore.bind(firstStore),
      transact: async (mutations, now) => {
        if (mutations.length === 2) { entered(); await barrier; }
        return firstStore.transact(mutations, now);
      }
    };
    const effect = fence(delayed).commitProtected(issued, {
      namespace: 'provider-effects', key: 'uncommitted',
      expectedGeneration: null, value: { verified: true }
    });
    await pause;
    const revoked = await fence(secondStore).revoke(who);
    resume();
    await assert.rejects(effect, e => e?.code === 'CONTROL_PLANE_CAS_MISMATCH');
    assert.equal(await firstStore.get('provider-effects', 'uncommitted'), null);
    await assert.rejects(fence(firstStore).assertCurrent(issued),
      e => e?.code === 'REMOTE_AUTHORITY_FENCE_LOST');
    assert.ok(revoked.generation > issued.generation);
  });

  test('successful PostgreSQL guarded commit is linearized before later revocation', async () => {
    const who = subject();
    const token = await fence(firstStore).acquire(who, 'effect-host');
    const committed = await fence(secondStore).commitProtected(token, {
      namespace: 'provider-effects', key: 'committed',
      expectedGeneration: null, value: { verified: true }
    });
    assert.equal(committed.record?.value.verified, true);
    assert.ok(committed.lease.generation > token.generation);
    await fence(firstStore).revoke(who);
    await assert.rejects(fence(secondStore).commitProtected(committed.lease, {
      namespace: 'provider-effects', key: 'late', expectedGeneration: null,
      value: { verified: false }
    }), e => e?.code === 'REMOTE_AUTHORITY_FENCE_LOST');
    assert.equal(await secondStore.get('provider-effects', 'late'), null);
    assert.equal((await secondStore.get('provider-effects', 'committed'))?.value.verified, true);
  });
}
