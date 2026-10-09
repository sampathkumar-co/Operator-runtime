import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { PostgresQuarantineLedgerAnchor } from '../../src/core/postgres-quarantine-anchor.ts';

if (process.env.OPERATOR_REAL_PG_TEST !== '1') {
  test('independent PostgreSQL quarantine high-water requires ephemeral test database', { skip: true }, () => {});
} else {
  if (process.env.PGDATABASE !== 'operator_test') {
    throw new Error('Refusing real anchor integration outside ephemeral operator_test database');
  }
  const { Pool } = pg;
  const config = {
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'operator_test',
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    max: 8,
    connectionTimeoutMillis: 10_000
  };
  const left = new Pool(config), right = new Pool(config);
  test.after(async () => { await Promise.all([left.end(), right.end()]); });

  test('two independent PostgreSQL client pools CAS the same ledger epoch only once', async () => {
    const key = 'quarantine:test:' + crypto.randomUUID();
    const first = new PostgresQuarantineLedgerAnchor(left, key);
    const second = new PostgresQuarantineLedgerAnchor(right, key);
    await Promise.all([first.initialize(), second.initialize()]);
    const initial = await first.read();
    assert.deepEqual(initial, { count: 0, headMac: '0'.repeat(64) });
    const competing = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      (i % 2 ? first : second).compareAndAdvance(initial, {
        count: 1,
        headMac: crypto.createHash('sha256').update('challenger:' + i).digest('hex')
      })));
    assert.equal(competing.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(competing.filter(x => x.status === 'rejected').length, 7);
    const committed = await second.read();
    assert.equal(committed.count, 1);
    await assert.rejects(first.compareAndAdvance(initial, {
      count: 1, headMac: crypto.createHash('sha256').update('stale').digest('hex')
    }), (e) => e?.code === 'QUARANTINE_ANCHOR_CONFLICT');
    await first.compareAndAdvance(committed, {
      count: 2, headMac: crypto.createHash('sha256').update('next').digest('hex')
    });
    assert.equal((await second.read()).count, 2);
  });
}
