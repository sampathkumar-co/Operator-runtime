import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RelayResultStore } from '../src/core/relay-result-store.ts';
import { PipelineLatencyRecorder } from '../src/core/pipeline-latency.ts';

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

test('relay result wait wakes after the durable commit and preserves exact delivery identity', async (t) => {
  const state = await temp(t);
  const deviceId = crypto.randomUUID();
  const deliveryId = crypto.randomUUID();
  const store = new RelayResultStore(state);
  const waiting = store.waitFor(deviceId, 1, deliveryId, 2_000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await store.put(deviceId, 1, deliveryId, { ok: true });
  assert.equal((await waiting)?.deliveryId, deliveryId);
  assert.equal(await store.waitFor(deviceId, 1, crypto.randomUUID(), 10), null);
  const controller = new AbortController();
  const aborted = store.waitFor(deviceId, 2, crypto.randomUUID(), 2_000, controller.signal);
  controller.abort();
  assert.equal(await aborted, null);
});

test('relay result wait returns immediately for an already-aborted signal', async (t) => {
  const state = await temp(t);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await new RelayResultStore(state).waitFor(
    crypto.randomUUID(), 1, crypto.randomUUID(), 60_000, controller.signal
  ), null);
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

test('unacknowledged relay results survive TTL; only payload-free consumed tombstones are pruned', async (t) => {
  const state = await temp(t);
  const deviceId = crypto.randomUUID();
  const deliveryId = crypto.randomUUID();
  let now = new Date('2026-09-13T00:00:00.000Z');
  const store = new RelayResultStore(state, { clock: () => now, retentionMs: 60_000 });
  await store.put(deviceId, 1, deliveryId, { ok: true, output: { content: 'sensitive result' } });
  assert.equal((await store.get(deviceId, 1))?.result?.output?.content, 'sensitive result');

  now = new Date('2026-09-13T00:01:00.001Z');
  assert.equal((await store.get(deviceId, 1))?.result?.output?.content, 'sensitive result');
  assert.equal(await store.pruneExpired(), 0, 'unacknowledged result must never disappear by age alone');
  assert.equal(await new RelayResultStore(state).has(deviceId, 1, deliveryId), true);

  const consumed = await store.consume(deviceId, 1, deliveryId);
  assert.equal(consumed?.result?.output?.content, 'sensitive result');
  const redacted = await fs.readFile(path.join(state, 'relay-results.json'), 'utf8');
  assert.equal(redacted.includes('sensitive result'), false);
  assert.equal((await store.get(deviceId, 1)), null);

  now = new Date('2026-09-13T00:02:00.002Z');
  assert.equal(await store.pruneExpired(), 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(state, 'relay-results.json'), 'utf8')).streams, []);
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


test('unconsumed replay authority remains available until acknowledged, even after retention age', async (t) => {
  const state = await temp(t);
  const deviceId = crypto.randomUUID();
  const deliveryId = crypto.randomUUID();
  const key = 'a'.repeat(64);
  const authority = { accountId: crypto.randomUUID(), deviceId, generation: 3 };
  let now = new Date('2026-09-13T00:00:50.000Z');
  const store = new RelayResultStore(state, { clock: () => now, retentionMs: 60_000 });
  await store.put(deviceId, 7, deliveryId, { ok: true, output: { value: 'late-complete' } }, key, authority);
  const firstReplay = await store.findByIdempotencyKey(key);
  assert.equal(firstReplay?.result.deliveryId, deliveryId);
  assert.deepEqual(firstReplay?.result.replayAuthority, authority);

  now = new Date('2026-09-13T00:01:00.001Z');
  assert.equal((await store.findByIdempotencyKey(key))?.result.result?.output?.value, 'late-complete');

  now = new Date('2026-09-13T00:01:50.001Z');
  assert.equal((await store.findByIdempotencyKey(key))?.result.result?.output?.value, 'late-complete');
  assert.equal((await store.consume(deviceId, 7, deliveryId))?.result?.output?.value, 'late-complete');
  assert.equal(await store.findByIdempotencyKey(key), null);
  now = new Date('2026-09-13T00:02:50.002Z');
  assert.equal(await store.pruneExpired(), 1);
});

test('C09 result wait rejects coercible timeout values before registering listeners', async t => {
  const state = await temp(t);
  const store = new RelayResultStore(state);
  let coerced = 0;
  const attacker = { valueOf() { coerced++; return 1_000; } };
  for (const unsafe of ['1000', [1000], attacker, null]) {
    await assert.rejects(
      store.waitFor(crypto.randomUUID(), 1, crypto.randomUUID(), unsafe as number),
      (error: any) => error?.code === 'RELAY_RESULT_WAIT_INVALID'
    );
  }
  assert.equal(coerced, 0);
});

test('C11 injected recorder observes a durable relay result wait without altering its identity or result', async t => {
  const state = await temp(t);
  const recorder = new PipelineLatencyRecorder({ enabled: true, capacity: 8 });
  const store = new RelayResultStore(state, { latencyRecorder: recorder });
  const deviceId = crypto.randomUUID();
  const deliveryId = crypto.randomUUID();
  const awaiting = store.waitFor(deviceId, 1, deliveryId, 1000);
  const saved = await store.put(deviceId, 1, deliveryId, { ok: true, output: 'synthetic' });
  const actual = await awaiting;
  assert.equal(actual?.resultSha256, saved.result.resultSha256);
  assert.equal(actual?.deliveryId, deliveryId);
  assert.deepEqual(actual?.result, { ok: true, output: 'synthetic' });
  const spans = recorder.snapshot();
  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.stage, 'relay.result_wait');
  assert.equal(spans[0]?.origin, 'relay-server');
  assert.equal(spans[0]?.result, 'ok');
  assert.equal(spans[0]?.traceId.length, 64);
  const text = JSON.stringify(spans);
  assert.equal(text.includes(deviceId), false);
  assert.equal(text.includes(deliveryId), false);
  assert.equal(text.includes('synthetic'), false);
});

test('C11 disabled injected recorder and unchanged default relay wait produce identical results', async t => {
  const state = await temp(t);
  const disabled = new PipelineLatencyRecorder({ enabled: false });
  const instrumented = new RelayResultStore(state, { latencyRecorder: disabled });
  const regular = new RelayResultStore(state);
  const deviceId = crypto.randomUUID();
  const deliveryId = crypto.randomUUID();
  await regular.put(deviceId, 1, deliveryId, { ok: true });
  const [one,two] = await Promise.all([
    instrumented.waitFor(deviceId, 1, deliveryId, 1000),
    regular.waitFor(deviceId, 1, deliveryId, 1000)
  ]);
  assert.deepEqual(one,two);
  assert.deepEqual(disabled.snapshot(),[]);
});

test('C11 telemetry does not widen abort or mismatched delivery wait authority', async t => {
  const state = await temp(t);
  const recorder = new PipelineLatencyRecorder({ enabled: true });
  const store = new RelayResultStore(state, { latencyRecorder: recorder });
  const deviceId = crypto.randomUUID();
  const deliveryId = crypto.randomUUID();
  const badDelivery = crypto.randomUUID();
  await store.put(deviceId, 1, deliveryId, { ok: true });
  assert.equal(await store.waitFor(deviceId, 1, badDelivery, 20), null);
  const abort = new AbortController();
  abort.abort();
  assert.equal(await store.waitFor(deviceId, 1, deliveryId, 1000, abort.signal), null);
  // Early aborted calls do not register waiters or incur new observability.
  assert.equal(recorder.snapshot().length,1);
  assert.equal(recorder.snapshot()[0]?.result, 'failed', 'unfulfilled wait must not be reported as success');
  assert.equal((await store.get(deviceId, 1))?.deliveryId, deliveryId);
});


test('C08/C09 shared relay-result namespace rejects nonliteral values without conversion', async t => {
  const stateDir = await temp(t);
  let invoked = 0;
  const forged = {
    toString() { invoked++; return 'relay-result-streams'; },
    valueOf() { invoked++; return 'relay-result-streams'; }
  };
  for (const sharedNamespace of [
    ['relay-result-streams'], forged, null, 42, true, '', '__epoch',
    'relay-result-streams?bad'
  ]) {
    assert.throws(
      () => new RelayResultStore(stateDir, { sharedNamespace } as any),
      (error: any) => error?.code === 'RELAY_RESULT_SHARED_NAMESPACE_INVALID'
    );
  }
  assert.equal(invoked, 0, 'the shared-state boundary may never execute caller coercion hooks');
  assert.ok(new RelayResultStore(stateDir));
  assert.ok(new RelayResultStore(stateDir, { sharedNamespace: 'relay-result-streams/devices' }));
});
