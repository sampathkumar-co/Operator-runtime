import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EmbeddedControlPlaneStore } from '../src/core/control-plane-store.ts';
import { RelayDeliveryStore } from '../src/core/relay-delivery-store.ts';
import { RelayResultStore } from '../src/core/relay-result-store.ts';

const deviceId = '123e4567-e89b-42d3-a456-426614174000';
for (const type of ['delivery', 'result'] as const) {
  for (const value of ['1', true, [1], null, undefined]) {
    test('shared ' + type + ' epoch rejects coerced counter ' + String(value), async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-relay-epoch-type-'));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const shared = new EmbeddedControlPlaneStore(root);
      const ns = type === 'delivery' ? 'relay-delivery-streams' : 'relay-result-streams';
      const epoch = value === undefined ? {} : { counter: value };
      await shared.transact([{ namespace: ns, key: '__epoch', expectedGeneration: null, value: epoch }]);
      const action = type === 'delivery'
        ? () => new RelayDeliveryStore(root, { sharedStore: shared }).enqueue(deviceId, 'task.dispatch', { id: 'safe' })
        : () => new RelayResultStore(root, { sharedStore: shared }).put(deviceId, 1, crypto.randomUUID(), { ok: true });
      const expectedCode = type === 'delivery' ? 'RELAY_QUEUE_CORRUPT' : 'RELAY_RESULT_STATE_CORRUPT';
      await assert.rejects(action, (error: any) => error?.code === expectedCode);
      assert.deepEqual((await shared.get(ns, '__epoch'))?.value, epoch);
    });
  }
}

for (const type of ['delivery', 'result'] as const) {
  test('valid shared ' + type + ' epoch advances strictly as a JSON number', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-relay-valid-epoch-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const shared = new EmbeddedControlPlaneStore(root);
    const ns = type === 'delivery' ? 'relay-delivery-streams' : 'relay-result-streams';
    if (type === 'delivery') {
      const store = new RelayDeliveryStore(root, { sharedStore: shared });
      await store.enqueue(deviceId, 'task.dispatch', { id: 'one' });
      await store.enqueue(deviceId, 'task.dispatch', { id: 'two' });
    } else {
      const store = new RelayResultStore(root, { sharedStore: shared });
      await store.put(deviceId, 1, crypto.randomUUID(), { id: 'one' });
      await store.put(deviceId, 2, crypto.randomUUID(), { id: 'two' });
    }
    const epoch = await shared.get(ns, '__epoch');
    assert.equal(epoch?.value.counter, 2);
    assert.equal(typeof epoch?.value.counter, 'number');
  });
}
