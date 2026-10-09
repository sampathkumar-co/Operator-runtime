import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresQuarantineLedgerAnchor } from '../src/core/postgres-quarantine-anchor.ts';
import type { PostgresQueryHost, PostgresQueryResult } from '../src/core/control-plane-store.ts';

function fakeDatabase(): PostgresQueryHost {
  const stored = new Map<string, { count: number; headMac: string }>();
  return {
    async query<Row=Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<PostgresQueryResult<Row>> {
      let result: PostgresQueryResult<any> = { rows: [], rowCount: 0 };
      if (sql.startsWith('CREATE TABLE')) return result as PostgresQueryResult<Row>;
      if (sql.startsWith('INSERT INTO')) {
        const id = String(values[0]);
        if (!stored.has(id)) stored.set(id, { count: 0, headMac: String(values[1]) });
        return result as PostgresQueryResult<Row>;
      }
      if (sql.startsWith('SELECT record_count')) {
        const state = stored.get(String(values[0]));
        result = { rows: state ? [{ record_count: String(state.count), head_mac: state.headMac }] : [] };
        return result as PostgresQueryResult<Row>;
      }
      if (sql.startsWith('UPDATE mecord_quarantine_high_water')) {
        const [nextCount, nextHead, id, expectedCount, expectedHead] = values;
        const state = stored.get(String(id));
        if (state && state.count === expectedCount && state.headMac === expectedHead) {
          stored.set(String(id), { count: Number(nextCount), headMac: String(nextHead) });
          result = { rows: [], rowCount: 1 };
        }
        return result as PostgresQueryResult<Row>;
      }
      throw new Error('Unexpected query: ' + sql);
    }
  };
}

test('independent PostgreSQL high-water anchor rejects stale CAS, replay and skipped epochs', async () => {
  const db = fakeDatabase();
  const first = new PostgresQuarantineLedgerAnchor(db, 'tenant:test');
  const second = new PostgresQuarantineLedgerAnchor(db, 'tenant:test');
  await Promise.all([first.initialize(), second.initialize()]);
  const genesis = await first.read();
  assert.deepEqual(genesis, { count: 0, headMac: '0'.repeat(64) });
  const next = { count: 1, headMac: 'a'.repeat(64) };
  const races = await Promise.allSettled([
    first.compareAndAdvance(genesis, next),
    second.compareAndAdvance(genesis, { count: 1, headMac: 'b'.repeat(64) })
  ]);
  assert.equal(races.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(races.filter(r => r.status === 'rejected').length, 1);
  const current = await first.read();
  assert.equal(current.count, 1);
  assert.match(current.headMac, /^[ab]{64}$/);
  await assert.rejects(second.compareAndAdvance(genesis, next),
    (e: any) => e?.code === 'QUARANTINE_ANCHOR_CONFLICT');
  await assert.rejects(first.compareAndAdvance(current, { count: 3, headMac: 'c'.repeat(64) }),
    (e: any) => e?.code === 'QUARANTINE_ANCHOR_INVALID');
  await assert.rejects(first.compareAndAdvance(current, current),
    (e: any) => e?.code === 'QUARANTINE_ANCHOR_INVALID');
  await first.compareAndAdvance(current, { count: 2, headMac: 'd'.repeat(64) });
  assert.deepEqual(await second.read(), { count: 2, headMac: 'd'.repeat(64) });
});

test('independent PostgreSQL anchor never uses default identity or silently accepts absent row', async () => {
  const db = fakeDatabase();
  assert.throws(() => new PostgresQuarantineLedgerAnchor(db, ''),
    (e: any) => e?.code === 'QUARANTINE_ANCHOR_INVALID');
  const store = new PostgresQuarantineLedgerAnchor(db, 'not-provisioned');
  await assert.rejects(store.read(), (e: any) => e?.code === 'QUARANTINE_ANCHOR_INVALID');
  await store.initialize();
  assert.deepEqual(await store.read(), { count: 0, headMac: '0'.repeat(64) });
});
