import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TerminalSessionStore } from '../src/core/terminal-session-store.ts';

test('independent terminal-session stores retain exact ownership records and reject duplicate launches', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-terminal-cross-'));
  t.after(() => fs.rm(state, {recursive:true, force:true}));
  const stores = Array.from({length:8}, () => new TerminalSessionStore(state));
  const ids = Array.from({length:16}, () => crypto.randomUUID());
  await Promise.all(ids.map((id,i) => stores[i % stores.length]!.prepare({
    sessionId:id, executable:'test-launch-' + i
  })));
  assert.deepEqual(new Set((await new TerminalSessionStore(state).list()).map((record) => record.sessionId)),new Set(ids));
  const duplicate = crypto.randomUUID();
  const race = await Promise.allSettled([
    stores[0]!.prepare({sessionId:duplicate,executable:'test-one'}),
    stores[1]!.prepare({sessionId:duplicate,executable:'test-two'})
  ]);
  assert.equal(race.filter((r) => r.status === 'fulfilled').length,1);
  assert.equal(race.find((r):r is PromiseRejectedResult => r.status === 'rejected')?.reason?.code,
    'TERMINAL_SESSION_STATE_INVALID');
  const persisted = await new TerminalSessionStore(state).list();
  assert.equal(persisted.length,17);
  const winner = persisted.find((r) => r.sessionId === duplicate);
  assert.ok(winner);
  assert.ok(['test-one','test-two'].includes(winner.executable));

  await Promise.all(ids.map((id,i) => stores[i % stores.length]!.transition(id,'recovery_required')));
  const after = await stores[7]!.list();
  assert.equal(after.length,17);
  for (const id of ids) {
    const record = after.find((item) => item.sessionId === id);
    assert.equal(record?.state,'recovery_required');
    assert.equal(record?.revision,2);
  }
  assert.equal(after.find((item) => item.sessionId === duplicate)?.state,'launching');
});
