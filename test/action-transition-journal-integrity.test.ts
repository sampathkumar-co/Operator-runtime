import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ActionTransitionJournal } from '../src/core/action-transition-journal.ts';
import type { ActionRequest } from '../src/core/types.ts';

test('action journal rejects a historically impossible transition sequence', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-journal-history-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const journal = new ActionTransitionJournal(stateDir);
  const action: ActionRequest = {
    id: 'impossible-history',
    capability: 'file.write',
    risk: 'write',
    input: { path: 'example.txt', content: 'value' },
    provenance: { kind: 'trusted_policy' }
  };
  await journal.prepare({ action, ownerKind: 'test', ownerId: 'integrity', resourceKeys: [] });

  const file = path.join(stateDir, 'action-transitions.json');
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  const entry = state.entries[0];
  entry.state = 'UNCERTAIN';
  entry.transitions.push({
    seq: 2,
    state: 'UNCERTAIN',
    at: entry.updatedAt,
    provider: 'test.provider',
    resultDigest: 'a'.repeat(64)
  });
  await fs.writeFile(file, JSON.stringify(state), 'utf8');

  await assert.rejects(
    journal.list(),
    (error: unknown) => (error as { code?: string }).code === 'ACTION_JOURNAL_CORRUPT'
  );
});

test('action journal rejects transition metadata that contradicts the recorded state', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-journal-metadata-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const journal = new ActionTransitionJournal(stateDir);
  const action: ActionRequest = {
    id: 'contradictory-metadata',
    capability: 'computer.inspect',
    risk: 'read',
    input: { target: 'screen' },
    provenance: { kind: 'trusted_policy' }
  };
  await journal.prepare({ action, ownerKind: 'test', ownerId: 'integrity', resourceKeys: [] });

  const file = path.join(stateDir, 'action-transitions.json');
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  state.entries[0].transitions[0].verificationDigest = 'b'.repeat(64);
  await fs.writeFile(file, JSON.stringify(state), 'utf8');

  await assert.rejects(
    journal.inspect(action.id),
    (error: unknown) => (error as { code?: string }).code === 'ACTION_JOURNAL_CORRUPT'
  );
});

test('identical dispatched journal retries do not exhaust finite transition history', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-journal-idempotent-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const action: ActionRequest = {
    id: 'repeat-dispatch',
    capability: 'file.write',
    risk: 'write',
    input: { path: 'repeat.txt', content: 'same action' },
    provenance: { kind: 'trusted_policy' }
  };
  const journal = new ActionTransitionJournal(stateDir);
  await journal.prepare({ action, ownerKind: 'test', ownerId: 'retry', resourceKeys: [] });
  await journal.markDispatched(action.id, 'provider.a');

  for (let attempt = 0; attempt < 70; attempt += 1) {
    // Different store instances model worker restart/retry with identical evidence.
    await new ActionTransitionJournal(stateDir).markDispatched(action.id, 'provider.a');
  }
  const persisted = await new ActionTransitionJournal(stateDir).inspect(action.id);
  assert.equal(persisted.state, 'DISPATCHED');
  assert.equal(persisted.transitions.length, 2);
  assert.equal(persisted.transitions[1]?.provider, 'provider.a');

  await journal.markDispatched(action.id, 'provider.b');
  const changed = await journal.inspect(action.id);
  assert.equal(changed.transitions.length, 3);
  assert.equal(changed.transitions[2]?.provider, 'provider.b');
});
