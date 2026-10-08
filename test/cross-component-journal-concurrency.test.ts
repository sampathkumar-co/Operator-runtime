import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableCompensationJournal } from '../src/core/compensation-journal.ts';

test('independent coordinator instances cannot lose each others durable recovery intents', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-cross-journal-'));
  t.after(async () => fs.rm(state, { recursive: true, force: true }));
  const journals = Array.from({ length: 8 }, () => new DurableCompensationJournal(state));
  const inputs = Array.from({ length: 64 }, (_, index) => ({
    id: crypto.randomUUID(),
    ownerKind: index % 2 === 0 ? 'digital-operation' : 'organization',
    ownerId: crypto.randomUUID(),
    operation: 'cancel-team-mission',
    targetId: crypto.randomUUID()
  }));
  const prepared = await Promise.all(inputs.map((input, i) => journals[i % journals.length]!.prepare(input)));
  assert.equal(new Set(prepared.map((item) => item.id)).size, inputs.length);
  const visible = await new DurableCompensationJournal(state).pending();
  assert.deepEqual(new Set(visible.map((item) => item.id)), new Set(inputs.map((item) => item.id)));
  assert.equal((await journals[0]!.pending('digital-operation')).length, 32);
  assert.equal((await journals[1]!.pending('organization')).length, 32);

  await Promise.all(inputs.filter((_, i) => i % 3 === 0).map((item, i) => journals[i % journals.length]!.complete(item.id)));
  const remaining = await new DurableCompensationJournal(state).pending();
  const expected = inputs.filter((_, i) => i % 3 !== 0).map((item) => item.id);
  assert.deepEqual(new Set(remaining.map((item) => item.id)), new Set(expected));

  // Mix additions and deletions across different instances; neither side can
  // accidentally revert the other's confirmed durable transaction.
  const added = Array.from({ length: 12 }, () => ({
    id: crypto.randomUUID(), ownerKind: 'digital-operation', ownerId: crypto.randomUUID(),
    operation: 'release-device-reservation', targetId: crypto.randomUUID()
  }));
  await Promise.all([
    ...added.map((input, i) => journals[i % journals.length]!.prepare(input)),
    ...remaining.slice(0, 12).map((item, i) => journals[i % journals.length]!.complete(item.id))
  ]);
  const final = await journals[3]!.pending();
  assert.deepEqual(
    new Set(final.map((item) => item.id)),
    new Set([...remaining.slice(12).map((item) => item.id), ...added.map((item) => item.id)])
  );
});
