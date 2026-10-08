import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RelayDeliveryStore } from '../src/core/relay-delivery-store.ts';
import { RelayResultStore } from '../src/core/relay-result-store.ts';

test('file-backed relay delivery stores preserve idempotency and monotonic sequence across instances', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-relay-multi-delivery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stores = Array.from({ length: 8 }, () => new RelayDeliveryStore(dir));
  const deviceId = crypto.randomUUID(), idempotencyKey = crypto.randomBytes(32).toString('hex');
  const two = await Promise.all([
    stores[0]!.enqueue(deviceId, 'action', { kind: 'verify' }, undefined, idempotencyKey),
    stores[1]!.enqueue(deviceId, 'action', { kind: 'verify' }, undefined, idempotencyKey)
  ]);
  assert.equal(two[0]!.id, two[1]!.id);
  assert.equal(two[0]!.seq, 1);
  const additional = await Promise.all(Array.from({ length: 16 }, (_, i) =>
    stores[i % stores.length]!.enqueue(deviceId, 'action', { item: i }, undefined, crypto.createHash('sha256').update('different-' + i).digest('hex'))
  ));
  assert.equal(new Set(additional.map((item) => item.id)).size, 16);
  assert.deepEqual(additional.map((item) => item.seq).sort((a,b) => a-b), Array.from({ length: 16 }, (_, i) => i + 2));
  const reloaded = new RelayDeliveryStore(dir);
  assert.equal((await reloaded.pending(deviceId, 40)).length, 17);
  assert.deepEqual(await reloaded.cursor(deviceId), { lastAckedSeq: 0, highestEnqueuedSeq: 17 });
  assert.equal((await stores[3]!.findIdempotent(idempotencyKey))?.delivery.id, two[0]!.id);
});

test('file-backed relay result stores preserve one exact result under concurrent receipt and retain other results', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-relay-multi-result-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stores = Array.from({ length: 8 }, () => new RelayResultStore(dir));
  const deviceId = crypto.randomUUID(), deliveryId = crypto.randomUUID();
  const concurrent = await Promise.all([
    stores[0]!.put(deviceId, 1, deliveryId, { ok: true }, crypto.randomBytes(32).toString('hex')),
    stores[1]!.put(deviceId, 1, deliveryId, { ok: true })
  ]);
  assert.deepEqual(concurrent.map((item) => item.duplicate).sort(), [false, true]);
  const more = await Promise.all(Array.from({ length: 16 }, (_, i) =>
    stores[i % stores.length]!.put(deviceId, i + 2, crypto.randomUUID(), { value: i })
  ));
  assert.equal(more.length, 16);
  const reloaded = new RelayResultStore(dir);
  assert.equal((await reloaded.get(deviceId, 1))?.deliveryId, deliveryId);
  for (let i = 0; i < 16; i++) assert.deepEqual((await reloaded.get(deviceId, i + 2))?.result, { value: i });
  await assert.rejects(stores[2]!.put(deviceId, 1, deliveryId, { ok: false }),
    (error: any) => error?.code === 'RELAY_RESULT_CONFLICT');
});
