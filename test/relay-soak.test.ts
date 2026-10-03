import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RelayDeliveryStore } from '../src/core/relay-delivery-store.ts';

const DEVICE = '123e4567-e89b-42d3-a456-426614174000';
const WRONG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function temp(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('relay 1000-delivery soak survives periodic reloads and reconciles the full cursor exactly once', async (t) => {
  const state = await temp(t, 'operator-relay-soak-');
  let store = new RelayDeliveryStore(state);

  for (let index = 1; index <= 1000; index += 1) {
    const queued = await store.enqueue(DEVICE, 'task.dispatch', { index });
    assert.equal(queued.seq, index);
    if (index % 100 === 0) store = new RelayDeliveryStore(state);
  }

  assert.deepEqual(await store.cursor(DEVICE), { lastAckedSeq: 0, highestEnqueuedSeq: 1000 });
  assert.equal((await store.pending(DEVICE, 500)).length, 500);
  assert.deepEqual(
    await store.reconcileClientCursor(DEVICE, 1000),
    { lastAckedSeq: 1000, advanced: 1000 }
  );
  assert.deepEqual(await store.cursor(DEVICE), { lastAckedSeq: 1000, highestEnqueuedSeq: 1000 });
  assert.deepEqual(await store.pending(DEVICE), []);

  const persisted = JSON.parse(await fs.readFile(path.join(state, 'relay-deliveries.json'), 'utf8'));
  assert.equal(persisted.version, 2);
  assert.equal(persisted.streams[0].baseSeq, 745);
  assert.equal(persisted.streams[0].highestCompactedAckedSeq, 744);
  assert.equal(persisted.streams[0].deliveries.length, 256);
  assert.equal(persisted.streams[0].deliveries[0].seq, 745);
  assert.equal(persisted.streams[0].deliveries.at(-1).seq, 1000);
  assert.equal(persisted.streams[0].deliveries.every((entry: any) => entry.status === 'acked'), true);
  assert.equal(persisted.streams[0].deliveries.every((entry: any) => Object.keys(entry.payload).length === 0), true);

  const reloaded = new RelayDeliveryStore(state);
  assert.deepEqual(await reloaded.cursor(DEVICE), { lastAckedSeq: 1000, highestEnqueuedSeq: 1000 });
});

test('relay fault soak rejects invalid acknowledgements across restarts and recovers only from valid durable bytes', async (t) => {
  const state = await temp(t, 'operator-relay-fault-soak-');
  let store = new RelayDeliveryStore(state);
  const deliveries = [];

  for (let index = 1; index <= 120; index += 1) {
    deliveries.push(await store.enqueue(DEVICE, 'action', { index }));
  }

  for (let index = 1; index <= deliveries.length; index += 1) {
    const delivery = deliveries[index - 1]!;
    if (index < deliveries.length) {
      await assert.rejects(
        store.acknowledge(DEVICE, index + 1, deliveries[index]!.id),
        (error: any) => error?.code === 'RELAY_ACK_GAP'
      );
    }
    await assert.rejects(
      store.acknowledge(DEVICE, index, WRONG_ID),
      (error: any) => error?.code === 'RELAY_ACK_MISMATCH'
    );
    assert.deepEqual(
      await store.acknowledge(DEVICE, index, delivery.id),
      { lastAckedSeq: index, duplicate: false }
    );
    if (index % 10 === 0) {
      store = new RelayDeliveryStore(state);
      assert.deepEqual(await store.cursor(DEVICE), {
        lastAckedSeq: index,
        highestEnqueuedSeq: deliveries.length
      });
    }
  }

  const file = path.join(state, 'relay-deliveries.json');
  const valid = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, '{"version":1,"streams":[');
  const corrupted = new RelayDeliveryStore(state);
  await assert.rejects(
    corrupted.cursor(DEVICE),
    (error: any) => error?.code === 'RELAY_QUEUE_CORRUPT'
  );

  await fs.writeFile(file, valid);
  const recovered = new RelayDeliveryStore(state);
  assert.deepEqual(await recovered.cursor(DEVICE), {
    lastAckedSeq: 120,
    highestEnqueuedSeq: 120
  });
  assert.deepEqual(await recovered.pending(DEVICE), []);
});
