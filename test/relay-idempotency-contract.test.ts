import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RelayDeliveryStore } from '../src/core/relay-delivery-store.ts';

test('relay idempotency key binds kind, canonical payload and exact account generation', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-relay-contract-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const delivery = new RelayDeliveryStore(dir);
  const second = new RelayDeliveryStore(dir);
  const deviceId = crypto.randomUUID();
  const key = crypto.randomBytes(32).toString('hex');
  const authority = { accountId: crypto.randomUUID(), deviceId, generation: 4 };
  const first = await delivery.enqueue(deviceId, 'action', { meta: { b: 2, a: 1 }, action: 'safe' }, authority, key);
  const replay = await second.enqueue(deviceId, 'action', { action: 'safe', meta: { a: 1, b: 2 } }, { ...authority }, key);
  assert.equal(replay.id, first.id);
  assert.equal(replay.seq, first.seq);
  for (const entry of [
    { kind: 'task', payload: { action: 'safe', meta: { a: 1, b: 2 } }, auth: authority },
    { kind: 'action', payload: { action: 'dangerous', meta: { a: 1, b: 2 } }, auth: authority },
    { kind: 'action', payload: { action: 'safe', meta: { a: 1, b: 2 } }, auth: { ...authority, generation: 5 } },
    { kind: 'action', payload: { action: 'safe', meta: { a: 1, b: 2 } }, auth: undefined }
  ]) {
    await assert.rejects(second.enqueue(deviceId, entry.kind, entry.payload, entry.auth, key),
      (error: any) => error?.code === 'RELAY_IDEMPOTENCY_CONTRACT_CHANGED');
  }
  assert.equal((await new RelayDeliveryStore(dir).pending(deviceId)).length, 1);
  assert.equal((await new RelayDeliveryStore(dir).cursor(deviceId)).highestEnqueuedSeq, 1);
});
