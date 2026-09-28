import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConversationLedger } from '../src/core/conversation-ledger.ts';

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-conversation-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('conversation ledger preserves ordered immutable turns and content digests', async (t) => {
  const ledger = new ConversationLedger(await temp(t), 'chat-1');
  const first = await ledger.append({ role: 'user', content: 'Do not deploy yet.' });
  const second = await ledger.append({ role: 'assistant', content: 'Understood.', supersedes: [] });
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  const turns = await ledger.list();
  assert.deepEqual(turns.map((turn) => turn.sequence), [1, 2]);
  assert.equal(turns[0]?.content, 'Do not deploy yet.');
  assert.match(turns[0]!.contentDigest, /^[0-9a-f]{64}$/);
});

test('conversation ledger can retain only a digest when content retention is disabled', async (t) => {
  const ledger = new ConversationLedger(await temp(t), 'chat-2');
  const turn = await ledger.append({ role: 'user', content: 'sensitive local-only detail', retainContent: false });
  assert.equal(turn.content, undefined);
  const [stored] = await ledger.list();
  assert.equal(stored?.content, undefined);
  assert.match(stored!.contentDigest, /^[0-9a-f]{64}$/);
});
