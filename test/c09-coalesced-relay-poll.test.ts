import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RelayResultStore } from '../src/core/relay-result-store.ts';

async function fixture(t: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-c09-coalesced-relay-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('C09 100 concurrent missing-result waits share one bounded backend poll', async t => {
  const root = await fixture(t);
  let reads = 0;
  const shared = {
    async list() { reads++; return []; }
  };
  const receiver = new RelayResultStore(root, { sharedStore: shared as any });
  const abort = new AbortController();
  const device = crypto.randomUUID();
  const pending = Array.from({ length: 100 }, (_, n) =>
    receiver.waitFor(device, n + 1, crypto.randomUUID(), 10_000, abort.signal));
  await new Promise(resolve => setTimeout(resolve, 180));
  abort.abort();
  assert.ok((await Promise.all(pending)).every(result => result === null));
  assert.ok(reads >= 1, 'cross-process polling must actually read shared state');
  assert.ok(reads <= 15, 'the backend must not be queried once per waiting action');
});

test('C09 a separate writer instance still wakes exact device and sequence waiters', async t => {
  const root = await fixture(t);
  const reader = new RelayResultStore(root);
  const writer = new RelayResultStore(root);
  const device = crypto.randomUUID();
  const wrongDevice = crypto.randomUUID();
  const firstId = crypto.randomUUID();
  const secondId = crypto.randomUUID();
  const first = reader.waitFor(device, 1, firstId, 2_000);
  const second = reader.waitFor(device, 2, secondId, 2_000);
  const wrong = reader.waitFor(wrongDevice, 1, crypto.randomUUID(), 2_000);
  const controller = new AbortController();
  const cancelled = reader.waitFor(device, 3, crypto.randomUUID(), 2_000, controller.signal);
  await writer.put(device, 1, firstId, { ok: true, output: { step: 1 } });
  await writer.put(device, 2, secondId, { ok: true, output: { step: 2 } });
  assert.equal((await first)?.deliveryId, firstId);
  assert.equal((await second)?.deliveryId, secondId);
  controller.abort();
  assert.equal(await cancelled, null);
  // Different device with the same sequence must not observe the result.
  // Explicit abort avoids relying on a real-time 2-second test timeout.
  const distinct = await reader.waitFor(wrongDevice, 1, crypto.randomUUID(), 10);
  assert.equal(distinct, null);
  await writer.put(wrongDevice, 1, crypto.randomUUID(), { ok: true });
  assert.equal(await wrong, null, 'wrong delivery identity cannot be accepted');
});

test('C09 corrupt or unavailable shared state fails all waiters, never looks like a clean timeout', async t => {
  const root = await fixture(t);
  const store = new RelayResultStore(root, {
    sharedStore: {
      async list() { throw new Error('synthetic shared database outage'); }
    } as any
  });
  const device = crypto.randomUUID();
  const waits = Array.from({ length: 20 }, (_, n) =>
    store.waitFor(device, n + 1, crypto.randomUUID(), 2_000));
  const outcomes = await Promise.allSettled(waits);
  assert.equal(outcomes.filter(x => x.status === 'rejected').length, 20);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') assert.match(String(outcome.reason), /synthetic shared database outage/);
  }
});
