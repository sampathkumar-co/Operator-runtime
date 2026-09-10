import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskStore } from '../src/core/task-store.ts';
import { createTask } from '../src/core/task.ts';

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

function task() {
  return createTask({
    userObjective: 'ship safely',
    interpretedObjective: 'ship safely',
    authorizedScope: ['repo'],
    prohibitedScope: [],
    successConditions: ['tests pass']
  });
}

test('TaskStore rejects a persisted capsule with an impossible state', async (t) => {
  const state = await tempDir(t, 'operator-task-invalid-state-');
  const value = task();
  const tasksDir = path.join(state, 'tasks');
  await fs.mkdir(tasksDir);
  await fs.writeFile(path.join(tasksDir, `${value.id}.json`), JSON.stringify({ ...value, state: 'OWNED' }), { mode: 0o600 });

  await assert.rejects(
    () => new TaskStore(state).get(value.id),
    (error: any) => error?.code === 'TASK_STATE_CORRUPT' && /task state is invalid/.test(error.message)
  );
});

test('TaskStore rejects symlinked task files instead of reading their targets', async (t) => {
  const state = await tempDir(t, 'operator-task-file-link-');
  const value = task();
  const tasksDir = path.join(state, 'tasks');
  await fs.mkdir(tasksDir);
  const outside = path.join(state, 'outside-task.json');
  await fs.writeFile(outside, JSON.stringify(value), { mode: 0o600 });
  if (!(await makeSymlinkOrSkip(t, outside, path.join(tasksDir, `${value.id}.json`), 'file'))) return;

  await assert.rejects(
    () => new TaskStore(state).get(value.id),
    (error: any) => error?.code === 'TASK_STATE_CORRUPT'
  );
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

test('TaskStore rejects cyclic persisted task dependency graphs', async (t) => {
  const state = await tempDir(t, 'operator-task-cycle-');
  const value = task();
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  value.nodes = [
    { id: first, title: 'first', state: 'PENDING', required: true, dependsOn: [second], evidence: [] },
    { id: second, title: 'second', state: 'PENDING', required: true, dependsOn: [first], evidence: [] }
  ];

  await assert.rejects(
    () => new TaskStore(state).put(value),
    (error: any) => error?.code === 'TASK_STATE_CORRUPT' && /cycle/.test(error.message)
  );
});

test('TaskStore list omits corrupt state entries instead of trusting their shape', async (t) => {
  const state = await tempDir(t, 'operator-task-list-corrupt-');
  const store = new TaskStore(state);
  const valid = task();
  await store.put(valid);
  const corruptId = crypto.randomUUID();
  await fs.writeFile(path.join(state, 'tasks', `${corruptId}.json`), JSON.stringify({ id: corruptId, state: 'VERIFIED' }), { mode: 0o600 });

  const listed = await store.list(Number.NaN);
  assert.deepEqual(listed.map((entry) => entry.id), [valid.id]);
});
