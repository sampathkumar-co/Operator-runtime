import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskStore } from '../src/core/task-store.ts';
import { createTask, type TaskCapsule } from '../src/core/task.ts';

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return await fs.realpath(dir);
}

async function makeSymlinkOrSkip(t: test.TestContext, target: string, link: string, type: 'file' | 'junction'): Promise<boolean> {
  try {
    await fs.symlink(target, link, type);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      t.skip(`symlink creation is unavailable on this runner (${code})`);
      return false;
    }
    throw error;
  }
}

function task(): TaskCapsule {
  return createTask({
    userObjective: 'ship safely',
    interpretedObjective: 'ship safely',
    authorizedScope: ['repo'],
    prohibitedScope: [],
    successConditions: ['tests pass']
  });
}

async function writePersisted(state: string, filenameId: string, value: unknown): Promise<void> {
  const tasksDir = path.join(state, 'tasks');
  await fs.mkdir(tasksDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(tasksDir, `${filenameId}.json`), JSON.stringify(value), { mode: 0o600 });
}

async function expectCorrupt(action: () => Promise<unknown>, message?: RegExp): Promise<void> {
  await assert.rejects(
    action,
    (error: any) => error?.code === 'TASK_STATE_CORRUPT' && (!message || message.test(error.message))
  );
}

test('TaskStore persists and reloads a valid task capsule unchanged', async (t) => {
  const state = await tempDir(t, 'operator-task-roundtrip-');
  const store = new TaskStore(state);
  const value = task();
  value.evidence.push({
    kind: 'test',
    status: 'pass',
    message: 'verified',
    data: { count: 1, nested: { ok: true } },
    timestamp: value.updatedAt
  });

  await store.put(value);
  assert.deepEqual(await store.get(value.id), value);
});

test('TaskStore rejects a persisted capsule with an impossible state', async (t) => {
  const state = await tempDir(t, 'operator-task-invalid-state-');
  const value = task();
  await writePersisted(state, value.id, { ...value, state: 'OWNED' });

  await expectCorrupt(() => new TaskStore(state).get(value.id), /task state is invalid/);
});

test('TaskStore rejects a persisted capsule whose ID does not match its filename', async (t) => {
  const state = await tempDir(t, 'operator-task-id-mismatch-');
  const requested = task();
  const other = task();
  await writePersisted(state, requested.id, other);

  await expectCorrupt(() => new TaskStore(state).get(requested.id), /does not match/);
});

test('TaskStore treats malformed UUIDs inside persisted state as corruption', async (t) => {
  const state = await tempDir(t, 'operator-task-invalid-id-');
  const value = task();
  await writePersisted(state, value.id, { ...value, id: 'not-a-uuid' });

  await expectCorrupt(() => new TaskStore(state).get(value.id), /invalid task or node id/);
});

test('TaskStore rejects duplicate node IDs', async (t) => {
  const state = await tempDir(t, 'operator-task-duplicate-node-');
  const value = task();
  const id = crypto.randomUUID();
  value.nodes = [
    { id, title: 'first', state: 'PENDING', required: true, dependsOn: [], evidence: [] },
    { id, title: 'second', state: 'PENDING', required: true, dependsOn: [], evidence: [] }
  ];
  await writePersisted(state, value.id, value);

  await expectCorrupt(() => new TaskStore(state).get(value.id), /duplicates node id/);
});

test('TaskStore rejects missing dependency references', async (t) => {
  const state = await tempDir(t, 'operator-task-missing-dependency-');
  const value = task();
  value.nodes = [{
    id: crypto.randomUUID(),
    title: 'blocked',
    state: 'PENDING',
    required: true,
    dependsOn: [crypto.randomUUID()],
    evidence: []
  }];
  await writePersisted(state, value.id, value);

  await expectCorrupt(() => new TaskStore(state).get(value.id), /invalid dependency/);
});

test('TaskStore rejects cyclic persisted task dependency graphs', async (t) => {
  const state = await tempDir(t, 'operator-task-cycle-');
  const value = task();
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  value.nodes = [
    { id: first, title: 'first', state: 'PENDING', required: true, dependsOn: [second], evidence: [] },
    { id: second, title: 'second', state: 'PENDING', required: true, dependsOn: [first], evidence: [] }
  ];
  await writePersisted(state, value.id, value);

  await expectCorrupt(() => new TaskStore(state).get(value.id), /cycle/);
});

test('TaskStore rejects malformed persisted evidence', async (t) => {
  const state = await tempDir(t, 'operator-task-bad-evidence-');
  const value = task();
  await writePersisted(state, value.id, {
    ...value,
    evidence: [{ kind: 'test', status: 'trusted', message: 'bad', timestamp: value.updatedAt }]
  });

  await expectCorrupt(() => new TaskStore(state).get(value.id), /status is invalid/);
});

test('TaskStore rejects malformed persisted timestamps', async (t) => {
  const state = await tempDir(t, 'operator-task-bad-time-');
  const value = task();
  await writePersisted(state, value.id, { ...value, updatedAt: '2026-09-10 10:00:00' });

  await expectCorrupt(() => new TaskStore(state).get(value.id), /ISO timestamp/);
});

test('TaskStore rejects oversized persisted collections and strings', async (t) => {
  const state = await tempDir(t, 'operator-task-bounds-');
  const collectionTask = task();
  await writePersisted(state, collectionTask.id, {
    ...collectionTask,
    authorizedScope: Array.from({ length: 1001 }, (_, index) => `scope-${index}`)
  });
  await expectCorrupt(() => new TaskStore(state).get(collectionTask.id), /at most 1000 entries/);

  const stringTask = task();
  await writePersisted(state, stringTask.id, {
    ...stringTask,
    userObjective: 'x'.repeat(256 * 1024 + 1)
  });
  await expectCorrupt(() => new TaskStore(state).get(stringTask.id), /userObjective is invalid/);
});

test('TaskStore rejects symlinked task files instead of reading their targets', async (t) => {
  const state = await tempDir(t, 'operator-task-file-link-');
  const value = task();
  const tasksDir = path.join(state, 'tasks');
  await fs.mkdir(tasksDir);
  const outside = path.join(state, 'outside-task.json');
  await fs.writeFile(outside, JSON.stringify(value), { mode: 0o600 });
  if (!(await makeSymlinkOrSkip(t, outside, path.join(tasksDir, `${value.id}.json`), 'file'))) return;

  await expectCorrupt(() => new TaskStore(state).get(value.id));
});

test('TaskStore write refuses to replace a symlinked task file and leaves the external target unchanged', async (t) => {
  const state = await tempDir(t, 'operator-task-write-link-');
  const value = task();
  const store = new TaskStore(state);
  await store.init();
  const outside = path.join(state, 'outside-target.txt');
  const sentinel = 'outside-must-not-change';
  await fs.writeFile(outside, sentinel, { mode: 0o600 });
  const link = path.join(state, 'tasks', `${value.id}.json`);
  if (!(await makeSymlinkOrSkip(t, outside, link, 'file'))) return;

  await expectCorrupt(() => store.put(value));
  assert.equal(await fs.readFile(outside, 'utf8'), sentinel);
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
});

test('TaskStore refuses a symlinked tasks directory before persisting', async (t) => {
  const state = await tempDir(t, 'operator-task-dir-link-');
  const outside = await tempDir(t, 'operator-task-dir-target-');
  const tasksDir = path.join(state, 'tasks');
  if (!(await makeSymlinkOrSkip(t, outside, tasksDir, 'junction'))) return;

  await assert.rejects(
    () => new TaskStore(state).put(task()),
    (error: any) => error?.code === 'TASK_STATE_CORRUPT' && /real directory/.test(error.message)
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test('TaskStore list fails closed when a selected task entry is corrupt', async (t) => {
  const state = await tempDir(t, 'operator-task-list-corrupt-');
  const corruptId = '00000000-0000-4000-8000-000000000000';
  await writePersisted(state, corruptId, { id: corruptId, state: 'VERIFIED' });

  await expectCorrupt(() => new TaskStore(state).list(Number.NaN));
});

test('TaskStore list keeps NaN, Infinity, and huge limits bounded', async (t) => {
  const state = await tempDir(t, 'operator-task-list-bounds-');
  const tasksDir = path.join(state, 'tasks');
  await fs.mkdir(tasksDir, { recursive: true, mode: 0o700 });
  const base = task();
  const writes: Array<Promise<void>> = [];
  for (let index = 0; index < 501; index += 1) {
    const id = crypto.randomUUID();
    const value = { ...base, id, userObjective: `task-${index}` };
    writes.push(fs.writeFile(path.join(tasksDir, `${id}.json`), JSON.stringify(value), { mode: 0o600 }));
  }
  await Promise.all(writes);

  const store = new TaskStore(state);
  assert.equal((await store.list(Number.NaN)).length, 100);
  assert.equal((await store.list(Number.POSITIVE_INFINITY)).length, 100);
  assert.equal((await store.list(Number.MAX_SAFE_INTEGER)).length, 500);
});

test('TaskStore durable writes leave no stale temporary files', async (t) => {
  const state = await tempDir(t, 'operator-task-temp-cleanup-');
  const store = new TaskStore(state);
  const value = task();
  await store.put(value);

  const entries = await fs.readdir(path.join(state, 'tasks'));
  assert.deepEqual(entries, [`${value.id}.json`]);
  assert.equal(entries.some((name) => name.endsWith('.tmp')), false);
});
