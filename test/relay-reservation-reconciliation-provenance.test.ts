import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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


test('independent OS processes preserve distinct recovery intents and serialize identical retries', async t => {
  const { root } = await setup(t);
  const shared = {
    accountId: crypto.randomUUID(), operationId: crypto.randomUUID(),
    workloadKey: 'synthetic:shared-recovery', reservationId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(), action: 'release' as const,
    errorCode: 'DEVICE_POOL_RELEASE_FAILED'
  };
  const modulePath = fileURLToPath(new URL('../src/core/relay-reservation-reconciliation.ts', import.meta.url));
  const workerCode = [
    "import crypto from 'node:crypto';",
    "import {pathToFileURL} from 'node:url';",
    "const [modulePath, root, sharedJson, worker] = process.argv.slice(1);",
    "const {RelayReservationReconciliationStore} = await import(pathToFileURL(modulePath).href);",
    "const store = new RelayReservationReconciliationStore(root);",
    "const shared = JSON.parse(sharedJson);",
    "for (let i = 0; i < 6; i++) await store.record(shared);",
    "await store.record({...shared, reservationId: crypto.randomUUID(),",
    "  operationId: crypto.randomUUID(), workloadKey: 'synthetic:worker-' + worker});"
  ].join('\n');
  async function runWorker(worker: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--experimental-strip-types', '--input-type=module', '-e', workerCode,
        modulePath, root, JSON.stringify(shared), String(worker)
      ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let errors = '';
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error) reject(error);
        else resolve();
      };
      const deadline = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error('reservation reconciliation worker exceeded 30 seconds: ' + errors));
      }, 30_000);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { errors = (errors + chunk).slice(-4096); });
      child.once('error', error => finish(error));
      child.once('exit', (code, signal) => {
        if (code === 0) finish();
        else finish(new Error('reconciliation writer exited ' + code + '/' + signal + ': ' + errors));
      });
    });
  }
  await Promise.all(Array.from({ length: 4 }, (_, i) => runWorker(i)));
  const reopened = new RelayReservationReconciliationStore(root);
  const pending = await reopened.pending();
  assert.equal(pending.length, 5, '24 shared retries plus four distinct reservations must retain five pending intents');
  const original = pending.filter(item => item.reservationId === shared.reservationId);
  assert.equal(original.length, 1, 'concurrent shared retries must never duplicate the durable recovery intent');
  assert.equal(original[0]!.attempts, 24, 'every independently committed attempt must remain durable');
  const unique = pending.filter(item => item.reservationId !== shared.reservationId);
  assert.equal(unique.length, 4, 'independent OS processes must not lose their distinct recovery intents');
  assert.equal(new Set(unique.map(item => item.reservationId)).size, 4);
  await assert.rejects(
    reopened.record({ ...shared, operationId: crypto.randomUUID() }),
    (error: any) => error?.code === 'RELAY_RESERVATION_RECONCILIATION_CONFLICT'
  );
  assert.equal((await reopened.pending()).find(item => item.id === original[0]!.id)?.attempts, 24,
    'foreign identity conflicts must never mutate the legitimate recovery ledger');
  await reopened.resolve(original[0]!.id);
  assert.equal((await new RelayReservationReconciliationStore(root).pending()).length, 4,
    'resolving the shared intent must preserve all independently written pending records');
});
