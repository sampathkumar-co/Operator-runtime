import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableEventRuntime } from '../src/core/event-runtime.ts';

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-event-runtime-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('stage13 event delivery is durable and idempotent', async (t) => {
  const state = await temp(t);
  const runtime = new DurableEventRuntime(state);
  const waitId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  await runtime.wait({ waitId, eventType: 'github.pull_request.reviewed', correlationKey: 'pr:42' });
  const input = {
    id: eventId,
    type: 'github.pull_request.reviewed',
    correlationKey: 'pr:42',
    payloadDigest: crypto.createHash('sha256').update('review').digest('hex'),
    occurredAt: new Date().toISOString()
  };
  const first = await runtime.publish(input);
  const retry = await runtime.publish(input);
  assert.deepEqual(first.satisfiedWaitIds, [waitId]);
  assert.deepEqual(retry.satisfiedWaitIds, [waitId]);
  assert.equal((await new DurableEventRuntime(state).inspect(waitId)).state, 'SATISFIED');
});

test('stage13 timers wake without fabricating an external event', async (t) => {
  let now = new Date('2026-09-28T10:00:00.000Z');
  const runtime = new DurableEventRuntime(await temp(t), { clock: () => now });
  const wait = await runtime.wait({
    eventType: 'timer.elapsed',
    wakeAt: '2026-09-28T10:05:00.000Z',
    deadlineAt: '2026-09-28T10:10:00.000Z'
  });
  assert.deepEqual(await runtime.tick(), { woke: [], timedOut: [] });
  now = new Date('2026-09-28T10:05:00.000Z');
  assert.deepEqual(await runtime.tick(), { woke: [wait.id], timedOut: [] });
  const resolved = await runtime.inspect(wait.id);
  assert.equal(resolved.state, 'SATISFIED');
  assert.equal(resolved.satisfiedBy, `timer:${wait.id}`);
});

test('stage13 wait ids are conflict-safe across retries', async (t) => {
  const runtime = new DurableEventRuntime(await temp(t));
  const waitId = crypto.randomUUID();
  await runtime.wait({ waitId, eventType: 'device.online', correlationKey: 'device:a' });
  await assert.rejects(
    () => runtime.wait({ waitId, eventType: 'device.online', correlationKey: 'device:b' }),
    (error: any) => error?.code === 'EVENT_WAIT_ID_CONFLICT'
  );
});


test('stage13 terminal wait retention prevents lifetime admission exhaustion while active waits remain durable', async (t) => {
  let nowMs = Date.parse('2026-10-01T00:00:00.000Z');
  const clock = () => new Date(nowMs);
  const runtime = new DurableEventRuntime(await temp(t), {
    clock,
    maxWaits: 4,
    terminalRetentionMs: 1_000
  });

  const active = await runtime.wait({ eventType: 'device.online' });
  for (let index = 0; index < 40; index += 1) {
    const wait = await runtime.wait({ eventType: 'job.completed', correlationKey: `job:${index}` });
    await runtime.cancel(wait.id);
    nowMs += 1_001;
  }

  assert.equal((await runtime.inspect(active.id)).state, 'WAITING');
  const final = await runtime.wait({ eventType: 'job.completed', correlationKey: 'job:final' });
  assert.equal(final.state, 'WAITING');
});


test('stage13 terminal waits stay inspectable during retention and are reclaimed only after expiry', async (t) => {
  let nowMs = Date.parse('2026-10-01T10:00:00.000Z');
  const clock = () => new Date(nowMs);
  const runtime = new DurableEventRuntime(await temp(t), {
    clock,
    maxWaits: 2,
    terminalRetentionMs: 1_000
  });

  const first = await runtime.wait({ eventType: 'timer.elapsed' });
  await runtime.cancel(first.id);
  const retained = await runtime.inspect(first.id);
  assert.equal(retained.state, 'CANCELLED');
  assert.equal(retained.terminalAt, new Date(nowMs).toISOString());

  await runtime.wait({ eventType: 'device.online' });
  await assert.rejects(
    () => runtime.wait({ eventType: 'queue.full' }),
    (error: any) => error?.code === 'EVENT_WAIT_LIMIT'
  );
  nowMs += 1_001;
  const admitted = await runtime.wait({ eventType: 'queue.recovered' });
  assert.equal(admitted.state, 'WAITING');
  await assert.rejects(
    () => runtime.inspect(first.id),
    (error: any) => error?.code === 'EVENT_WAIT_NOT_FOUND'
  );
});
