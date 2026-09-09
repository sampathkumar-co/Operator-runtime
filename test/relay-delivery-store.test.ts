import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RelayDeliveryStore } from '../src/core/relay-delivery-store.ts';

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-relay-queue-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const DEVICE = '123e4567-e89b-42d3-a456-426614174000';

test('relay delivery queue assigns monotonic sequences and survives store reload', async (t) => {
  const state = await temp(t);
  const store = new RelayDeliveryStore(state);
  const first = await store.enqueue(DEVICE, 'task.dispatch', { taskId: 'a' });
  const second = await store.enqueue(DEVICE, 'task.dispatch', { taskId: 'b' });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.notEqual(first.id, second.id);

  const reloaded = new RelayDeliveryStore(state);
  assert.deepEqual((await reloaded.pending(DEVICE)).map((delivery) => delivery.seq), [1, 2]);
  assert.deepEqual(await reloaded.cursor(DEVICE), { lastAckedSeq: 0, highestEnqueuedSeq: 2 });
});

test('acknowledgements are ID-bound, contiguous, and duplicate-safe', async (t) => {
  const state = await temp(t);
  const store = new RelayDeliveryStore(state);
  const first = await store.enqueue(DEVICE, 'task.dispatch', { taskId: 'a' });
  const second = await store.enqueue(DEVICE, 'task.dispatch', { taskId: 'b' });

  await assert.rejects(store.acknowledge(DEVICE, 2, second.id), (error: any) => error?.code === 'RELAY_ACK_GAP');
  await assert.rejects(store.acknowledge(DEVICE, 1, second.id), (error: any) => error?.code === 'RELAY_ACK_MISMATCH');
  assert.deepEqual(await store.acknowledge(DEVICE, 1, first.id), { lastAckedSeq: 1, duplicate: false });
  assert.deepEqual(await store.acknowledge(DEVICE, 1, first.id), { lastAckedSeq: 1, duplicate: true });
  assert.deepEqual((await store.pending(DEVICE)).map((delivery) => delivery.seq), [2]);
});

test('signed client resume cursor can reconcile a lost ACK forward but never backward or beyond server history', async (t) => {
  const state = await temp(t);
  const store = new RelayDeliveryStore(state);
  const first = await store.enqueue(DEVICE, 'task.dispatch', { taskId: 'a' });
  await store.enqueue(DEVICE, 'task.dispatch', { taskId: 'b' });
  await store.enqueue(DEVICE, 'task.dispatch', { taskId: 'c' });
  await store.acknowledge(DEVICE, 1, first.id);

  const reconciled = await store.reconcileClientCursor(DEVICE, 2);
  assert.deepEqual(reconciled, { lastAckedSeq: 2, advanced: 1 });
  assert.deepEqual((await store.pending(DEVICE)).map((delivery) => delivery.seq), [3]);

  await assert.rejects(store.reconcileClientCursor(DEVICE, 1), (error: any) => error?.code === 'RELAY_RESUME_BEHIND');
  await assert.rejects(store.reconcileClientCursor(DEVICE, 4), (error: any) => error?.code === 'RELAY_RESUME_AHEAD');
});

test('zero resume on a never-seen stream is allowed but a positive unknown cursor is rejected', async (t) => {
  const store = new RelayDeliveryStore(await temp(t));
  assert.deepEqual(await store.reconcileClientCursor(DEVICE, 0), { lastAckedSeq: 0, advanced: 0 });
  await assert.rejects(store.reconcileClientCursor(DEVICE, 1), (error: any) => error?.code === 'RELAY_RESUME_AHEAD');
});

test('relay payloads are JSON-bounded snapshots rather than mutable caller objects', async (t) => {
  const store = new RelayDeliveryStore(await temp(t));
  const payload: any = { task: { id: 'x' } };
  const queued = await store.enqueue(DEVICE, 'task.dispatch', payload);
  payload.task.id = 'mutated';
  assert.equal((queued.payload.task as any).id, 'x');
  assert.equal(((await store.pending(DEVICE))[0].payload.task as any).id, 'x');

  await assert.rejects(
    store.enqueue(DEVICE, 'task.dispatch', { huge: 'x'.repeat(140 * 1024) }),
    (error: any) => error?.code === 'RELAY_PAYLOAD_TOO_LARGE'
  );
});
