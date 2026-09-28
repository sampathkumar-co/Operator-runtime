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
