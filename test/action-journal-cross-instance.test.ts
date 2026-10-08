import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ActionTransitionJournal } from '../src/core/action-transition-journal.ts';
import type { ActionRequest } from '../src/core/types.ts';

test('independent action journal instances serialize preparation, exact-identity conflicts, and transitions', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-action-journal-cross-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const journals = Array.from({ length: 8 }, () => new ActionTransitionJournal(state));
  const action = (id: string, value: number): ActionRequest => ({
    id, capability: 'computer.inspect', risk: 'read',
    input: { target: 'screen', value }, provenance: { kind: 'trusted_policy' }
  });
  const inputs = Array.from({ length: 16 }, (_, i) => action('cross-action-' + i, i));
  await Promise.all(inputs.map((item, i) => journals[i % journals.length]!.prepare({
    action: item, ownerKind: 'test', ownerId: 'cross-component', resourceKeys: []
  })));
  const loaded = await new ActionTransitionJournal(state).list(100);
  assert.deepEqual(new Set(loaded.map((entry) => entry.actionId)), new Set(inputs.map((item) => item.id)));

  const sameId = 'cross-identity-conflict';
  const conflict = await Promise.allSettled([
    journals[0]!.prepare({ action: action(sameId, 1), ownerKind: 'test', ownerId: 'cross-component', resourceKeys: [] }),
    journals[1]!.prepare({ action: action(sameId, 2), ownerKind: 'test', ownerId: 'cross-component', resourceKeys: [] })
  ]);
  assert.equal(conflict.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(conflict.filter((item) => item.status === 'rejected').length, 1);
  assert.equal(conflict.find((item): item is PromiseRejectedResult => item.status === 'rejected')?.reason?.code, 'ACTION_JOURNAL_ID_CONFLICT');

  await Promise.all(inputs.map((item, i) => journals[(i + 2) % journals.length]!.markDispatched(item.id, 'synthetic.provider')));
  const final = await new ActionTransitionJournal(state).list(100);
  assert.equal(final.length, 17);
  for (const original of inputs) {
    const persisted = final.find((entry) => entry.actionId === original.id);
    assert.equal(persisted?.state, 'DISPATCHED');
    assert.equal(persisted.transitions.length, 2);
    assert.equal(persisted.transitions[1]?.seq, 2);
  }
  assert.equal(final.find((entry) => entry.actionId === sameId)?.state, 'PREPARED');
});
