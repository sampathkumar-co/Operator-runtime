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

test('relay results expire by TTL and are physically pruned from durable state', async (t) => {
  const state = await temp(t);
  const deviceId = crypto.randomUUID();
  const deliveryId = crypto.randomUUID();
  let now = new Date('2026-09-13T00:00:00.000Z');
  const store = new RelayResultStore(state, { clock: () => now, retentionMs: 60_000 });
  await store.put(deviceId, 1, deliveryId, { ok: true, output: { content: 'sensitive result' } });
  assert.equal((await store.get(deviceId, 1))?.result.output?.content, 'sensitive result');

  now = new Date('2026-09-13T00:01:00.001Z');
  assert.equal(await store.get(deviceId, 1), null);
  assert.equal(await store.pruneExpired(), 1);

  const persisted = await fs.readFile(path.join(state, 'relay-results.json'), 'utf8');
  assert.equal(persisted.includes('sensitive result'), false);
  assert.deepEqual(JSON.parse(persisted).streams, []);
});


test('successful result consumption returns one copy and persists only a payload-free tombstone', async (t) => {
  const state = await temp(t);
  const deviceId = crypto.randomUUID();
  const deliveryId = crypto.randomUUID();
  const store = new RelayResultStore(state);
  await store.put(deviceId, 9, deliveryId, { ok: true, output: { content: 'consume-me-now' } });

  const consumed = await store.consume(deviceId, 9, deliveryId);
  assert.equal(consumed?.result?.output?.content, 'consume-me-now');
  assert.equal(await store.get(deviceId, 9), null);
  assert.equal(await store.consume(deviceId, 9, deliveryId), null);

  const persistedText = await fs.readFile(path.join(state, 'relay-results.json'), 'utf8');
  assert.equal(persistedText.includes('consume-me-now'), false);
  const entry = JSON.parse(persistedText).streams[0].results[0];
  assert.equal(entry.seq, 9);
  assert.equal(entry.deliveryId, deliveryId);
  assert.match(entry.resultSha256, /^[0-9a-f]{64}$/);
  assert.equal(typeof entry.consumedAt, 'string');
  assert.equal('result' in entry, false);

  const duplicate = await store.put(deviceId, 9, deliveryId, { ok: true, output: { content: 'consume-me-now' } });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.result.result, undefined);
});


test('completed replay authority remains available for the full result retention window', async (t) => {
  const state = await temp(t);
  const deviceId = crypto.randomUUID();
  const deliveryId = crypto.randomUUID();
  const key = 'a'.repeat(64);
  let now = new Date('2026-09-13T00:00:50.000Z');
  const store = new RelayResultStore(state, { clock: () => now, retentionMs: 60_000 });
  await store.put(deviceId, 7, deliveryId, { ok: true, output: { value: 'late-complete' } }, key);
  assert.equal((await store.findByIdempotencyKey(key))?.result.deliveryId, deliveryId);

  now = new Date('2026-09-13T00:01:00.001Z');
  assert.equal((await store.findByIdempotencyKey(key))?.result.result?.output?.value, 'late-complete');

  now = new Date('2026-09-13T00:01:50.001Z');
  assert.equal(await store.findByIdempotencyKey(key), null);
});
