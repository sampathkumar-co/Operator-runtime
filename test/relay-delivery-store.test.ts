import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RelayDeliveryStore } from '../src/core/relay-delivery-store.ts';

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-relay-queue-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const DEVICE = '123e4567-e89b-42d3-a456-426614174000';

test('relay delivery queue assigns monotonic sequences and survives store reload', async (t) => {
  const state = await temp(t);
  const store = new RelayDeliveryStore(state);
  const first = await store.enqueue(DEVICE, 'task.dispatch', { taskId: 'a' });
  const second = await store.enqueue(DEVICE, 'task.dispatch', { taskId: 'b' });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.notEqual(first.id, second.id);

  const reloaded = new RelayDeliveryStore(state);
  assert.deepEqual((await reloaded.pending(DEVICE)).map((delivery) => delivery.seq), [1, 2]);
  assert.deepEqual(await reloaded.cursor(DEVICE), { lastAckedSeq: 0, highestEnqueuedSeq: 2 });
});

test('relay delivery queue persists normalized capability requirements across reloads', async (t) => {
  const state = await temp(t);
  const store = new RelayDeliveryStore(state);
  const authority = { accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', deviceId: DEVICE, generation: 3 };
  const queued = await store.enqueue(
    DEVICE,
    'action',
    { action: { id: 'git-queued', capability: 'git.write' } },
    authority,
    undefined,
    ['git.write', 'file.read', 'git.write']
  );
  assert.deepEqual(queued.requiredCapabilities, ['file.read', 'git.write']);
  queued.requiredCapabilities?.push('docker.run');

  const reloaded = new RelayDeliveryStore(state);
  const [pending] = await reloaded.pending(DEVICE);
  assert.deepEqual(pending?.requiredCapabilities, ['file.read', 'git.write']);
  const persisted = JSON.parse(await fs.readFile(path.join(state, 'relay-deliveries.json'), 'utf8'));
  assert.deepEqual(persisted.streams[0].deliveries[0].requiredCapabilities, ['file.read', 'git.write']);

  await assert.rejects(
    store.enqueue(DEVICE, 'action', { action: { capability: 'file.read' } }, authority, undefined, ['bad\ncapability']),
    (error: any) => error?.code === 'RELAY_CAPABILITY_REQUIREMENTS_INVALID'
  );
});


test('capability-incompatible queue heads expire contiguously while preserving idempotent replay authority', async (t) => {
  const state = await temp(t);
  const store = new RelayDeliveryStore(state);
  const authority = { accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', deviceId: DEVICE, generation: 7 };
  const first = await store.enqueue(
    DEVICE,
    'action',
    { action: { id: 'git-old', capability: 'git.write' } },
    authority,
    'a'.repeat(64),
    ['git.write']
  );
  const second = await store.enqueue(
    DEVICE,
    'action',
    { action: { id: 'file-next', capability: 'file.read' } },
    authority,
    undefined,
    ['file.read']
  );

  assert.equal(await store.expireCapabilityIncompatibleHeads(DEVICE, ['file.read']), 1);
  assert.deepEqual(await store.cursor(DEVICE), { lastAckedSeq: 1, highestEnqueuedSeq: 2 });
  assert.deepEqual((await store.pending(DEVICE)).map((delivery) => delivery.id), [second.id]);
  const retired = await store.retained(DEVICE, first.seq);
  assert.equal(retired?.status, 'expired');
  assert.deepEqual(retired?.payload, {});
  assert.equal(retired?.requiredCapabilities, undefined);
  assert.deepEqual(retired?.replayAuthority, authority);
  assert.equal(await store.expireCapabilityIncompatibleHeads(DEVICE, ['file.read']), 0);
});

test('legacy pending action derives and persists its capability requirement during reload', async (t) => {
  const state = await temp(t);
  const authority = { accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', deviceId: DEVICE, generation: 5 };
  const legacy = {
    version: 1,
    streams: [{
      deviceId: DEVICE,
      nextSeq: 2,
      lastAckedSeq: 0,
      deliveries: [{
        seq: 1,
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        kind: 'action',
        payload: { action: { id: 'legacy-git', capability: 'git.write' } },
        authority,
        createdAt: '2026-09-16T18:00:00.000Z',
        status: 'pending'
      }]
    }]
  };
  await fs.writeFile(path.join(state, 'relay-deliveries.json'), JSON.stringify(legacy, null, 2));

  const store = new RelayDeliveryStore(state, { clock: () => new Date('2026-09-16T18:00:30.000Z') });
  const [pending] = await store.pending(DEVICE);
  assert.deepEqual(pending?.requiredCapabilities, ['git.write']);
  const migrated = JSON.parse(await fs.readFile(path.join(state, 'relay-deliveries.json'), 'utf8'));
  assert.deepEqual(migrated.streams[0].deliveries[0].requiredCapabilities, ['git.write']);
});

test('acknowledgements are ID-bound, contiguous, and duplicate-safe', async (t) => {
  const state = await temp(t);
  const store = new RelayDeliveryStore(state);
  const first = await store.enqueue(DEVICE, 'task.dispatch', { taskId: 'a' });
  const second = await store.enqueue(DEVICE, 'task.dispatch', { taskId: 'b' });

  await assert.rejects(store.acknowledge(DEVICE, 2, second.id), (error: any) => error?.code === 'RELAY_ACK_GAP');
  await assert.rejects(store.acknowledge(DEVICE, 1, second.id), (error: any) => error?.code === 'RELAY_ACK_MISMATCH');
  assert.deepEqual(await store.acknowledge(DEVICE, 1, first.id), { lastAckedSeq: 1, duplicate: false });
  assert.deepEqual(await store.acknowledge(DEVICE, 1, first.id), { lastAckedSeq: 1, duplicate: true });
  assert.deepEqual((await store.pending(DEVICE)).map((delivery) => delivery.seq), [2]);
});

test('signed client resume cursor can reconcile a lost ACK forward but never backward or beyond server history', async (t) => {
  const state = await temp(t);
  const store = new RelayDeliveryStore(state);
  const first = await store.enqueue(DEVICE, 'task.dispatch', { taskId: 'a' });
  await store.enqueue(DEVICE, 'task.dispatch', { taskId: 'b' });
  await store.enqueue(DEVICE, 'task.dispatch', { taskId: 'c' });
  await store.acknowledge(DEVICE, 1, first.id);

  const reconciled = await store.reconcileClientCursor(DEVICE, 2);
  assert.deepEqual(reconciled, { lastAckedSeq: 2, advanced: 1 });
  assert.deepEqual((await store.pending(DEVICE)).map((delivery) => delivery.seq), [3]);

  await assert.rejects(store.reconcileClientCursor(DEVICE, 1), (error: any) => error?.code === 'RELAY_RESUME_BEHIND');
  await assert.rejects(store.reconcileClientCursor(DEVICE, 4), (error: any) => error?.code === 'RELAY_RESUME_AHEAD');
});

test('zero resume on a never-seen stream is allowed but a positive unknown cursor is rejected', async (t) => {
  const store = new RelayDeliveryStore(await temp(t));
  assert.deepEqual(await store.reconcileClientCursor(DEVICE, 0), { lastAckedSeq: 0, advanced: 0 });
  await assert.rejects(store.reconcileClientCursor(DEVICE, 1), (error: any) => error?.code === 'RELAY_RESUME_AHEAD');
});

test('relay payloads are JSON-bounded snapshots rather than mutable caller objects', async (t) => {
  const store = new RelayDeliveryStore(await temp(t));
  const payload: any = { task: { id: 'x' } };
  const queued = await store.enqueue(DEVICE, 'task.dispatch', payload);
  payload.task.id = 'mutated';
  assert.equal((queued.payload.task as any).id, 'x');
  assert.equal(((await store.pending(DEVICE))[0].payload.task as any).id, 'x');

  await assert.rejects(
    store.enqueue(DEVICE, 'task.dispatch', { huge: 'x'.repeat(140 * 1024) }),
    (error: any) => error?.code === 'RELAY_PAYLOAD_TOO_LARGE'
  );
});

test('acknowledgement erases sensitive delivery payload while preserving sequence metadata', async (t) => {
  const state = await temp(t);
  const store = new RelayDeliveryStore(state);
  const queued = await store.enqueue(DEVICE, 'action', {
    action: { id: 'sensitive-action', input: { content: 'project source payload' } }
  });
  await store.acknowledge(DEVICE, queued.seq, queued.id);

  const persisted = JSON.parse(await fs.readFile(path.join(state, 'relay-deliveries.json'), 'utf8'));
  const record = persisted.streams[0].deliveries[0];
  assert.equal(record.seq, 1);
  assert.equal(record.id, queued.id);
  assert.equal(record.status, 'acked');
  assert.deepEqual(record.payload, {});
  assert.equal(JSON.stringify(persisted).includes('project source payload'), false);
});

test('pending delivery payload expires to a tombstone and reconnect may cross only that expired history', async (t) => {
  let nowMs = Date.parse('2026-09-13T10:00:00.000Z');
  const clock = () => new Date(nowMs);
  const state = await temp(t);
  const store = new RelayDeliveryStore(state, { clock, retentionMs: 60_000 });
  await store.enqueue(DEVICE, 'action', { action: { input: { content: 'stale source payload' } } });
  nowMs += 60_001;
  assert.deepEqual(await store.pending(DEVICE), []);
  assert.deepEqual(await store.cursor(DEVICE), { lastAckedSeq: 1, highestEnqueuedSeq: 1 });
  assert.deepEqual(await store.reconcileClientCursor(DEVICE, 0), { lastAckedSeq: 1, advanced: 1, expiredThroughSeq: 1 });
  const persisted = JSON.parse(await fs.readFile(path.join(state, 'relay-deliveries.json'), 'utf8'));
  const expired = persisted.streams[0].deliveries[0];
  assert.equal(expired.status, 'expired');
  assert.deepEqual(expired.payload, {});
  assert.equal(typeof expired.expiredAt, 'string');
  assert.equal(JSON.stringify(persisted).includes('stale source payload'), false);
  const fresh = await store.enqueue(DEVICE, 'action', { action: { input: { content: 'fresh' } } });
  assert.equal(fresh.seq, 2);
  assert.deepEqual((await store.pending(DEVICE)).map((delivery) => delivery.seq), [2]);
});

test('device purge erases old payloads while preserving the monotonic relay watermark for rebind', async (t) => {
  const state = await temp(t);
  const store = new RelayDeliveryStore(state);
  const first = await store.enqueue(DEVICE, 'action', { secret: 'owner-a-one' });
  const second = await store.enqueue(DEVICE, 'action', { secret: 'owner-a-two' });
  await store.acknowledge(DEVICE, first.seq, first.id);

  assert.equal(await store.purgeDevice(DEVICE), 2);
  assert.deepEqual(await store.cursor(DEVICE), { lastAckedSeq: 2, highestEnqueuedSeq: 2 });
  assert.deepEqual(await store.pending(DEVICE), []);
  assert.deepEqual(
    await store.reconcileClientCursor(DEVICE, 0),
    { lastAckedSeq: 2, advanced: 2, expiredThroughSeq: 2 }
  );

  const persisted = JSON.parse(await fs.readFile(path.join(state, 'relay-deliveries.json'), 'utf8'));
  assert.equal(JSON.stringify(persisted).includes('owner-a-one'), false);
  assert.equal(JSON.stringify(persisted).includes('owner-a-two'), false);
  assert.equal(persisted.streams[0].deliveries.every((entry: any) => entry.status === 'expired'), true);
  assert.equal(persisted.streams[0].deliveries.every((entry: any) => Object.keys(entry.payload).length === 0 && entry.authority === undefined), true);

  const fresh = await store.enqueue(DEVICE, 'action', { owner: 'b' });
  assert.equal(fresh.seq, 3);
  assert.deepEqual((await store.pending(DEVICE)).map((entry) => entry.seq), [3]);
});

test('invocation idempotency survives device ACK and reload, then expires on the bounded retention clock', async (t) => {
  let nowMs = Date.parse('2026-09-14T10:00:00.000Z');
  const clock = () => new Date(nowMs);
  const state = await temp(t);
  const store = new RelayDeliveryStore(state, { clock, retentionMs: 60_000 });
  const key = 'a'.repeat(64);
  const first = await store.enqueue(DEVICE, 'action', { action: { id: 'once' } }, undefined, key);
  const retryBeforeAck = await store.enqueue(DEVICE, 'action', { action: { id: 'once' } }, undefined, key);
  assert.equal(retryBeforeAck.seq, first.seq);
  assert.equal(retryBeforeAck.id, first.id);

  await store.acknowledge(DEVICE, first.seq, first.id);
  const reloaded = new RelayDeliveryStore(state, { clock, retentionMs: 60_000 });
  const recovered = await reloaded.findIdempotent(key);
  assert.equal(recovered?.deviceId, DEVICE);
  assert.equal(recovered?.delivery.id, first.id);
  assert.equal(recovered?.delivery.status, 'acked');
  const retryAfterAck = await reloaded.enqueue(DEVICE, 'action', { action: { id: 'once' } }, undefined, key);
  assert.equal(retryAfterAck.id, first.id);

  const distinctInvocationKey = 'b'.repeat(64);
  const intentionalRepeat = await reloaded.enqueue(DEVICE, 'action', { action: { id: 'once' } }, undefined, distinctInvocationKey);
  assert.equal(intentionalRepeat.seq, 2);
  assert.notEqual(intentionalRepeat.id, first.id);

  nowMs += 60_001;
  assert.equal(await reloaded.findIdempotent(key), null);
  const afterRetention = await reloaded.enqueue(DEVICE, 'action', { action: { id: 'once' } }, undefined, key);
  assert.equal(afterRetention.seq, 3);
});


test('expired idempotent delivery keeps a payload-free replay tombstone and blocks redispatch', async (t) => {
  let nowMs = Date.parse('2026-09-14T11:00:00.000Z');
  const clock = () => new Date(nowMs);
  const state = await temp(t);
  const store = new RelayDeliveryStore(state, { clock, retentionMs: 60_000 });
  const key = 'c'.repeat(64);
  const authority = { accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', deviceId: DEVICE, generation: 7 };
  const first = await store.enqueue(DEVICE, 'action', { secret: 'erase-me' }, authority, key);
  nowMs += 60_001;
  assert.deepEqual(await store.pending(DEVICE), []);
  const retained = await store.findIdempotent(key);
  assert.equal(retained?.delivery.status, 'expired');
  assert.equal(retained?.delivery.id, first.id);
  assert.deepEqual(retained?.delivery.payload, {});
  assert.equal(retained?.delivery.authority, undefined);
  assert.deepEqual(retained?.delivery.replayAuthority, authority);
  const retry = await store.enqueue(DEVICE, 'action', { secret: 'must-not-replace' }, undefined, key);
  assert.equal(retry.id, first.id);
  assert.equal(retry.status, 'expired');
});
