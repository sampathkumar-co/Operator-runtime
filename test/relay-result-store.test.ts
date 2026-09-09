import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RelayResultStore } from '../src/core/relay-result-store.ts';

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-relay-results-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('relay results persist idempotently and reject conflicting rewrites', async (t) => {
  const state = await temp(t);
  const deviceId = crypto.randomUUID();
  const deliveryId = crypto.randomUUID();
  const store = new RelayResultStore(state);
  const first = await store.put(deviceId, 1, deliveryId, { ok: true, output: { value: 42 } });
  assert.equal(first.duplicate, false);
  const duplicate = await store.put(deviceId, 1, deliveryId, { ok: true, output: { value: 42 } });
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual((await store.get(deviceId, 1))?.result, { ok: true, output: { value: 42 } });

  await assert.rejects(
    store.put(deviceId, 1, deliveryId, { ok: false, error: 'forged replacement' }),
    (error: any) => error?.code === 'RELAY_RESULT_CONFLICT'
  );

  const reloaded = new RelayResultStore(state);
  assert.equal(await reloaded.has(deviceId, 1, deliveryId), true);
  assert.deepEqual((await reloaded.get(deviceId, 1))?.result, { ok: true, output: { value: 42 } });
});

test('relay result payloads are bounded and stored hashes are corruption-detecting', async (t) => {
  const state = await temp(t);
  const deviceId = crypto.randomUUID();
  const deliveryId = crypto.randomUUID();
  const store = new RelayResultStore(state);
  await assert.rejects(
    store.put(deviceId, 1, deliveryId, { data: 'x'.repeat(300 * 1024) }),
    (error: any) => error?.code === 'RELAY_RESULT_TOO_LARGE'
  );

  await store.put(deviceId, 1, deliveryId, { ok: true });
  const file = path.join(state, 'relay-results.json');
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  parsed.streams[0].results[0].result.ok = false;
  await fs.writeFile(file, JSON.stringify(parsed));
  await assert.rejects(
    new RelayResultStore(state).get(deviceId, 1),
    (error: any) => error?.code === 'RELAY_RESULT_STATE_CORRUPT'
  );
});
