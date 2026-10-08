import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EmbeddedControlPlaneStore } from '../src/core/control-plane-store.ts';
import { RelayDeliveryStore } from '../src/core/relay-delivery-store.ts';

for (const backend of ['file', 'shared'] as const) {
  test(backend + ': pending relay retries bind their original payload, kind, capabilities, and account authority', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-relay-retry-invariant-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const makeStore = () => new RelayDeliveryStore(dir,
      backend === 'shared' ? { sharedStore: new EmbeddedControlPlaneStore(dir) } : {});
    const a = makeStore(), b = makeStore();
    const deviceId = crypto.randomUUID();
    const accountId = crypto.randomUUID();
    const authority = { accountId, deviceId, generation: 2 };
    const key = crypto.randomBytes(32).toString('hex');
    const input = { action: { capability: 'file.read', input: { alpha: 1, beta: 2 } }, traceId: 'operation-1' };
    const reordered = { traceId: 'operation-1', action: { input: { beta: 2, alpha: 1 }, capability: 'file.read' } };
    const first = await a.enqueue(deviceId, 'action', input, authority, key, ['file.read']);
    const replay = await b.enqueue(deviceId, 'action', reordered, authority, key, ['file.read']);
    assert.equal(replay.id, first.id);
    assert.equal(replay.seq, first.seq);
    const reject = async (kind: string, payload: Record<string, unknown>, owner: typeof authority, caps: string[], expected: string) => {
      await assert.rejects(b.enqueue(deviceId, kind, payload, owner, key, caps),
        (error: any) => error?.code === expected);
    };
    await reject('task', input, authority, ['file.read'], 'RELAY_IDEMPOTENCY_INPUT_CHANGED');
    await reject('action', { ...input, action: { capability: 'file.read', input: { alpha: 3, beta: 2 } } }, authority, ['file.read'], 'RELAY_IDEMPOTENCY_INPUT_CHANGED');
    await reject('action', input, { ...authority, generation: 3 }, ['file.read'], 'RELAY_IDEMPOTENCY_AUTHORITY_CHANGED');
    await reject('action', input, { ...authority, accountId: crypto.randomUUID() }, ['file.read'], 'RELAY_IDEMPOTENCY_AUTHORITY_CHANGED');
    await reject('action', input, authority, ['file.write'], 'RELAY_IDEMPOTENCY_CAPABILITY_CHANGED');
    await assert.rejects(b.enqueue(crypto.randomUUID(), 'action', input, undefined, key, ['file.read']),
      (error: any) => error?.code === 'RELAY_IDEMPOTENCY_ROUTE_CHANGED');
    const persisted = await makeStore().findIdempotent(key);
    assert.equal(persisted?.delivery.id, first.id);
    assert.deepEqual(persisted?.delivery.payload, input);
    assert.deepEqual(persisted?.delivery.authority, authority);
    assert.equal((await makeStore().pending(deviceId)).length, 1);
  });
}
