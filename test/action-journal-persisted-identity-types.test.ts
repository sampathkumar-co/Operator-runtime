import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ActionTransitionJournal } from '../src/core/action-transition-journal.ts';

for (const field of ['generation', 'actionId', 'actionDigest', 'createdAt', 'updatedAt'] as const) {
  test('persisted action journal rejects coerced ' + field + ' identity', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-journal-exact-types-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const journal = new ActionTransitionJournal(dir);
    await journal.prepare({
      action: { id: 'single-effect', capability: 'file.write', risk: 'write', input: { text: 'approved' }, provenance: { kind: 'trusted_policy' } },
      ownerKind: 'task', ownerId: 'owned-task', resourceKeys: []
    });
    const file = path.join(dir, 'action-transitions.json');
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    const entry = state.entries[0];
    entry[field] = field === 'generation' ? '1' : [entry[field]];
    const corrupted = JSON.stringify(state);
    await fs.writeFile(file, corrupted);
    await assert.rejects(new ActionTransitionJournal(dir).list(),
      (error: any) => ['ACTION_JOURNAL_CORRUPT', 'ACTION_JOURNAL_INPUT_INVALID'].includes(error?.code));
    assert.equal(await fs.readFile(file, 'utf8'), corrupted, 'invalid durable state must not be silently rewritten');
  });
}
