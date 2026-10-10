import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RelayDeliveryStore } from '../src/core/relay-delivery-store.ts';

const DEVICE = '123e4567-e89b-42d3-a456-426614174000';

for (const version of ['2', '1', true, [2]]) {
  test('persisted relay queue rejects coerced schema version ' + JSON.stringify(version), async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-relay-schema-integrity-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new RelayDeliveryStore(root);
    const original = await store.enqueue(DEVICE, 'task.dispatch', { taskId: 'queued' });
    const file = path.join(root, 'relay-deliveries.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(raw.version, 2);
    raw.version = version;
    const before = JSON.stringify(raw);
    await fs.writeFile(file, before, { mode: 0o600 });
    await assert.rejects(new RelayDeliveryStore(root).pending(DEVICE),
      (error: any) => error?.code === 'RELAY_QUEUE_CORRUPT');
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.equal(original.seq, 1);
  });
}
