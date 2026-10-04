import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalActionExecutionStore } from '../apps/local-agent/src/action-execution-store.ts';

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-action-execution-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function action(id = 'action-1') {
  return {
    id,
    capability: 'file.create',
    risk: 'write' as const,
    input: { path: 'C:\\repo\\receipt.txt', content: 'hello' },
    provenance: { kind: 'chatgpt' as const }
  };
}

const authority = {
  accountId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
  generation: 3
};

const result = {
  ok: true,
  capability: 'file.create',
  provider: 'filesystem.native',
  output: { path: 'C:\\repo\\receipt.txt', created: true },
  evidence: [],
  durationMs: 12
};

test('durable action execution receipt completes once and replays exact result after restart', async (t) => {
  const state = await temp(t);
  const store = new LocalActionExecutionStore(state);
  assert.equal((await store.begin(action(), authority)).status, 'started');
  const completed = await store.complete(action(), result, authority);
  assert.equal(completed.status, 'completed');

  const restarted = new LocalActionExecutionStore(state);
  const replay = await restarted.begin(action(), authority);
  assert.equal(replay.status, 'completed');
  assert.deepEqual(replay.status === 'completed' ? replay.result : null, result);
  assert.deepEqual((await restarted.lookup(action(), authority)).status, 'completed');
});

test('processing action execution receipt survives restart and prevents blind duplicate execution', async (t) => {
  const state = await temp(t);
  const store = new LocalActionExecutionStore(state);
  assert.equal((await store.begin(action('processing'), authority)).status, 'started');

  const restarted = new LocalActionExecutionStore(state);
  const duplicate = await restarted.begin(action('processing'), authority);
  assert.equal(duplicate.status, 'processing');
  assert.equal((await restarted.lookup(action('processing'), authority)).status, 'processing');
});

test('orphaned processing read is reclaimable after process restart while mutations remain blocked', async (t) => {
  const state = await temp(t);
  const readAction = {
    id: 'read-restart',
    capability: 'file.read',
    risk: 'read' as const,
    input: { path: 'C:\\repo\\receipt.txt' },
    provenance: { kind: 'chatgpt' as const }
  };
  const first = new LocalActionExecutionStore(state);
  assert.equal((await first.begin(readAction, authority)).status, 'started');

  const restarted = new LocalActionExecutionStore(state);
  assert.equal((await restarted.begin(readAction, authority)).status, 'started', 'read-only work may be reclaimed by a new process incarnation');

  const writeAction = action('write-restart');
  assert.equal((await first.begin(writeAction, authority)).status, 'started');
  const restartedAgain = new LocalActionExecutionStore(state);
  assert.equal((await restartedAgain.begin(writeAction, authority)).status, 'processing', 'mutation receipt must remain fail-closed across restart');
});

test('completed read receipt is never replayed as stale state', async (t) => {
  const state = await temp(t);
  const readAction = {
    id: 'read-fresh',
    capability: 'file.read',
    risk: 'read' as const,
    input: { path: 'C:\\repo\\fresh.txt' },
    provenance: { kind: 'chatgpt' as const }
  };
  const store = new LocalActionExecutionStore(state);
  assert.equal((await store.begin(readAction, authority)).status, 'started');
  await store.complete(readAction, {
    ok: true,
    capability: 'file.read',
    provider: 'filesystem.native',
    output: { content: 'old' },
    evidence: [],
    durationMs: 1
  }, authority);
  assert.equal((await store.begin(readAction, authority)).status, 'started', 'completed read must be executed again to observe current state');
});

test('action ID cannot be rebound to changed executable content', async (t) => {
  const state = await temp(t);
  const store = new LocalActionExecutionStore(state);
  await store.begin(action('content-bound'), authority);
  const changed = { ...action('content-bound'), input: { path: 'C:\\repo\\other.txt', content: 'changed' } };
  await assert.rejects(store.begin(changed, authority), (error: any) => error?.code === 'ACTION_EXECUTION_ACTION_MISMATCH');
});

test('action ID cannot be rebound to different account authority', async (t) => {
  const state = await temp(t);
  const store = new LocalActionExecutionStore(state);
  await store.begin(action('authority-bound'), authority);
  await assert.rejects(store.begin(action('authority-bound'), { ...authority, generation: 4 }), (error: any) => error?.code === 'ACTION_EXECUTION_AUTHORITY_MISMATCH');
});

test('completed receipt rejects a conflicting second result', async (t) => {
  const state = await temp(t);
  const store = new LocalActionExecutionStore(state);
  await store.begin(action('result-bound'), authority);
  await store.complete(action('result-bound'), result, authority);
  await assert.rejects(
    store.complete(action('result-bound'), { ...result, output: { path: 'different' } }, authority),
    (error: any) => error?.code === 'ACTION_EXECUTION_RESULT_CONFLICT'
  );
});
