import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RelayResultStore } from '../src/core/relay-result-store.ts';

test('C08/C09 consumed replay tombstone never wakes a new result waiter', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-c08-consumed-result-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const device = crypto.randomUUID();
  const delivery = crypto.randomUUID();
  const store = new RelayResultStore(dir);
  await store.put(device, 1, delivery, { ok: true, output: { marker: 'safe-fixture' } });
  assert.ok((await store.consume(device, 1, delivery))?.result);
  const pending = store.waitFor(device, 1, delivery, 120);
  const duplicate = await store.put(device, 1, delivery, { ok: true, output: { marker: 'safe-fixture' } });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.result.result, undefined);
  // A ref'ed watchdog prevents the Node event loop from exiting while the
  // production timeout is intentionally unref'ed. Not a success shortcut.
  await Promise.race([
    pending.then(result => assert.equal(result, null, 'ACKed tombstone must not complete another waiter')),
    new Promise((_, reject) => setTimeout(() => reject(new Error('wait never settled')), 1500))
  ]);
  assert.equal(await store.get(device, 1), null);
});

test('C08 new committed results still notify exact delivery once', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-c08-fresh-result-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const device = crypto.randomUUID();
  const delivery = crypto.randomUUID();
  const store = new RelayResultStore(dir);
  const waiting = store.waitFor(device, 2, delivery, 1000);
  await store.put(device, 2, delivery, { ok: true, output: 'fresh' });
  const result = await waiting;
  assert.equal(result?.deliveryId, delivery);
  assert.equal(result?.result?.output, 'fresh');
});
