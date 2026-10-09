import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RelayReservationReconciliationStore } from '../src/core/relay-reservation-reconciliation.ts';

async function setup(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-reconciliation-provenance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: new RelayReservationReconciliationStore(root) };
}

test('reservation reconciliation cannot alias a different operation, session or lease to an existing pending record', async t => {
  const { store } = await setup(t);
  const binding = {
    accountId: crypto.randomUUID(), operationId: crypto.randomUUID(),
    workloadKey: 'operation:owned', reservationId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(), action: 'renew' as const,
    leaseMs: 60_000, errorCode: 'DEVICE_POOL_HEARTBEAT_FAILED'
  };
  const first = await store.record(binding);
  for (const changed of [
    { ...binding, operationId: crypto.randomUUID() },
    { ...binding, workloadKey: 'operation:foreign' },
    { ...binding, sessionId: crypto.randomUUID() },
    { ...binding, leaseMs: 120_000 }
  ]) {
    await assert.rejects(store.record(changed), (error: any) => error?.code === 'RELAY_RESERVATION_RECONCILIATION_CONFLICT');
  }
  const [unchanged] = await store.pending();
  assert.equal(unchanged?.id, first.id);
  assert.equal(unchanged?.sessionId, binding.sessionId);
  assert.equal(unchanged?.leaseMs, binding.leaseMs);
  assert.equal(unchanged?.attempts, 1);
  const retry = await store.record(binding);
  assert.equal(retry.id, first.id);
  assert.equal(retry.attempts, 2);
});

test('malformed durable reconciliation records fail closed before any recovery action', async t => {
  const { root, store } = await setup(t);
  const valid = await store.record({
    accountId: crypto.randomUUID(), operationId: crypto.randomUUID(),
    workloadKey: 'operation:owned', reservationId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(), action: 'release', errorCode: 'DEVICE_POOL_RELEASE_FAILED'
  });
  const file = path.join(root, 'relay-reservation-reconciliation.json');
  const original = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const changed of [
    { ...valid, action: 'releasee' },
    { ...valid, accountId: 'not-an-account' },
    { ...valid, attempts: -1 },
    { ...valid, state: 'RESOLVED' },
    { ...valid, sessionId: null },
    { ...valid, updatedAt: 'invalid' }
  ]) {
    await fs.writeFile(file, JSON.stringify({ ...original, records: [changed] }));
    await assert.rejects(store.pending(), (error: any) => error?.code === 'RELAY_RESERVATION_RECONCILIATION_CORRUPT');
  }
  await fs.writeFile(file, JSON.stringify({ ...original, records: [valid, { ...valid }] }));
  await assert.rejects(store.pending(), (error: any) => error?.code === 'RELAY_RESERVATION_RECONCILIATION_CORRUPT');
});
