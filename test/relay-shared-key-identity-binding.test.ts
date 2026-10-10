import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EmbeddedControlPlaneStore } from '../src/core/control-plane-store.ts';
import { RelayDeliveryStore } from '../src/core/relay-delivery-store.ts';
import { RelayResultStore } from '../src/core/relay-result-store.ts';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
for (const kind of ['delivery', 'result'] as const) {
  for (const tamper of ['key-mismatch', 'version-mismatch'] as const) {
    test('shared ' + kind + ' record rejects ' + tamper + ' before presenting data to another device', async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-shared-stream-binding-'));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const cp = new EmbeddedControlPlaneStore(root);
      const ns = kind === 'delivery' ? 'relay-delivery-streams' : 'relay-result-streams';
      if (kind === 'delivery') {
        await new RelayDeliveryStore(root, { sharedStore: cp }).enqueue(A, 'task.dispatch', { secret: 'only-device-A' });
      } else {
        await new RelayResultStore(root, { sharedStore: cp }).put(A, 1, crypto.randomUUID(), { secret: 'only-device-A' });
      }
      const original = await cp.get(ns, A);
      assert.ok(original);
      const saved = structuredClone(original!.value);
      const stream = saved.stream as Record<string, unknown>;
      if (tamper === 'key-mismatch') stream.deviceId = B;
      else saved.stateVersion = kind === 'delivery' ? '2' : '1';
      await cp.transact([{
        namespace: ns, key: A, expectedGeneration: original!.generation, value: saved
      }]);
      const probe = kind === 'delivery'
        ? () => new RelayDeliveryStore(root, { sharedStore: cp }).pending(tamper === 'key-mismatch' ? B : A)
        : () => new RelayResultStore(root, { sharedStore: cp }).get(tamper === 'key-mismatch' ? B : A, 1);
      const code = kind === 'delivery' ? 'RELAY_QUEUE_CORRUPT' : 'RELAY_RESULT_STATE_CORRUPT';
      await assert.rejects(probe, (error: any) => error?.code === code);
      assert.deepEqual((await cp.get(ns, A))!.value, saved);
    });
  }
}
