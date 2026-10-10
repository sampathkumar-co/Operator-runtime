import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EmbeddedControlPlaneStore, PostgresControlPlaneStore } from '../src/core/control-plane-store.ts';

test('embedded control plane rejects array-shaped persisted namespace and key aliases', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-cp-identity-types-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new EmbeddedControlPlaneStore(root);
  const [original] = await store.transact([{ namespace: 'account-scope', key: 'device-1', expectedGeneration: null, value: { owner: 'A' } }]);
  assert.ok(original);
  for (const action of [
    () => store.get(['account-scope'] as any, 'device-1'),
    () => store.get('account-scope', ['device-1'] as any),
    () => store.list(['account-scope'] as any),
    () => store.transact([{ namespace: 'account-scope', key: ['device-1'] as any, expectedGeneration: original.generation, value: { owner: 'B' } }])
  ]) {
    await assert.rejects(action, (error: any) => error?.code === 'CONTROL_PLANE_STORE_INVALID');
  }
  assert.deepEqual((await store.get('account-scope', 'device-1'))?.value, { owner: 'A' });
});

test('embedded control plane rejects array-shaped ISO timestamps and digest identities', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-cp-time-types-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new EmbeddedControlPlaneStore(root);
  const now = '2026-10-10T00:00:00.000Z';
  await assert.rejects(
    store.transact([{ namespace: 'n', key: 'k', expectedGeneration: null, value: { ok: true } }], [now] as any),
    (error: any) => error?.code === 'CONTROL_PLANE_STORE_INVALID'
  );
  const [record] = await store.transact([{ namespace: 'n', key: 'k', expectedGeneration: null, value: { ok: true } }], now);
  const file = path.join(root, 'control-plane-store.json');
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  state.records[0].valueDigest = [record.valueDigest];
  await fs.writeFile(file, JSON.stringify(state));
  await assert.rejects(store.get('n', 'k'), (error: any) => error?.code === 'CONTROL_PLANE_STORE_INVALID');
});

test('Postgres control plane rejects a nonstring key before querying another record', async () => {
  let queried = 0;
  const db = { async query(){queried++; return { rows: [] };} };
  const store = new PostgresControlPlaneStore(db);
  await assert.rejects(store.get('n', ['k'] as any), (error: any) => error?.code === 'CONTROL_PLANE_STORE_INVALID');
  await assert.rejects(store.list(['n'] as any), (error: any) => error?.code === 'CONTROL_PLANE_STORE_INVALID');
  assert.equal(queried, 0);
});
