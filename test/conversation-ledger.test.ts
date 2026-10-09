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

test('independent conversation ledger writers append contiguous durable turns without sequence races', async (t) => {
  const state = await temp(t);
  const writers = Array.from({ length: 8 }, () => new ConversationLedger(state, 'parallel-chat'));
  const appended = await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      writers[index % writers.length]!.append({ role: 'user', content: 'turn-' + index })
    )
  );
  const readBack = await new ConversationLedger(state, 'parallel-chat').list();
  assert.equal(readBack.length, 24);
  assert.deepEqual(readBack.map(item => item.sequence), Array.from({ length: 24 }, (_, i) => i + 1));
  assert.equal(new Set(readBack.map(item => item.id)).size, 24);
  assert.deepEqual(
    new Set(readBack.map(item => item.content)),
    new Set(Array.from({ length: 24 }, (_, i) => 'turn-' + i))
  );
  assert.equal(new Set(appended.map(item => item.sequence)).size, 24);
});

test('conversation ledger refuses turns from another durable conversation identity', async (t) => {
  const state = await temp(t);
  const ledger = new ConversationLedger(state, 'scoped-chat');
  await ledger.append({ role: 'user', content: 'bound to this conversation' });
  const file = path.join(state, 'conversations', 'scoped-chat.ndjson');
  const turns = (await fs.readFile(file, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  turns[0].conversationId = 'different-chat';
  await fs.writeFile(file, turns.map(item => JSON.stringify(item)).join('\n') + '\n');
  await assert.rejects(
    () => new ConversationLedger(state, 'scoped-chat').list(),
    (error: any) => error?.code === 'CONVERSATION_LEDGER_CORRUPT'
  );
});
