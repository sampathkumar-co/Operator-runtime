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

test('TaskStore rejects malformed durable execution records and impossible timing', async (t) => {
  const state = await tempDir(t, 'operator-task-bad-execution-');
  const value = task();
  const now = value.createdAt;
  const execution = {
    schemaVersion: 1,
    plannerId: 'test.planner',
    goalKind: 'test-goal',
    plannerState: { phase: 'start' },
    maxSteps: 10,
    maxAttemptsPerStep: 2,
    timeoutMs: 1000,
    stepCount: 1,
    startedAt: now,
    deadlineAt: new Date(Date.parse(now) + 1000).toISOString(),
    records: [{
      stepKey: 'one', actionId: 'action-one', capability: 'file.read', risk: 'owner',
      inputHash: 'a'.repeat(64), attempt: 1, state: 'STARTED', startedAt: now, evidence: []
    }]
  };
  await writePersisted(state, value.id, { ...value, execution });
  await expectCorrupt(() => new TaskStore(state).get(value.id), /risk is invalid/);

  execution.records[0]!.risk = 'read';
  (execution.records[0] as any).finishedAt = now;
  await writePersisted(state, value.id, { ...value, execution });
  await expectCorrupt(() => new TaskStore(state).get(value.id), /cannot finish while STARTED/);
});

test('TaskStore keeps observation schema v1 readable while validating normalized schema v2', async (t) => {
  const state = await tempDir(t, 'operator-task-observation-schema-');
  const value = task();
  const now = value.createdAt;
  const record = {
    stepKey: 'inspect', actionId: 'action-inspect', capability: 'file.read', risk: 'read',
    inputHash: 'a'.repeat(64), attempt: 1, state: 'SUCCEEDED', startedAt: now, finishedAt: now,
    observation: {
      schemaVersion: 1, channel: 'semantic', domain: 'filesystem',
      provider: 'filesystem', observedAt: now
    },
    evidence: []
  };
  value.execution = {
    schemaVersion: 1, plannerId: 'test.planner', goalKind: 'test-goal',
    plannerState: { phase: 'complete' }, maxSteps: 10, maxAttemptsPerStep: 2,
    timeoutMs: 1000, stepCount: 1, startedAt: now,
    deadlineAt: new Date(Date.parse(now) + 1000).toISOString(), records: [record]
  };
  await writePersisted(state, value.id, value);
  const loaded = await new TaskStore(state).get(value.id);
  assert.equal(loaded.execution?.records[0]?.observation?.schemaVersion, 1);

  (record.observation as any) = {
    schemaVersion: 2, channel: 'semantic', domain: 'filesystem', provider: 'filesystem',
    capability: 'file.read', entityId: `filesystem:${'a'.repeat(32)}`, observedAt: now,
    stateVersion: 'b'.repeat(64), importantState: { ok: true }, ambiguous: false,
    confidence: 2, evidenceRefs: []
  };
  await writePersisted(state, value.id, value);
  await expectCorrupt(() => new TaskStore(state).get(value.id), /confidence is invalid/);
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

test('TaskStore execution lease excludes a second process-local owner and releases cleanly', async (t) => {
  const state = await tempDir(t, 'operator-task-lease-exclusive-');
  const value = task();
  const firstStore = new TaskStore(state);
  const secondStore = new TaskStore(state);
  const lease = await firstStore.acquireExecutionLease(value.id);

  await assert.rejects(
    () => secondStore.acquireExecutionLease(value.id),
    (error: any) => error?.code === 'TASK_ALREADY_RUNNING'
  );
  await lease.assertOwned();
  await lease.release();
  const replacement = await secondStore.acquireExecutionLease(value.id);
  await replacement.release();
});

test('TaskStore reclaims an execution lease left by a crashed child process', async (t) => {
  const state = await tempDir(t, 'operator-task-lease-crash-');
  const value = task();
  const script = [
    "import { TaskStore } from './src/core/task-store.ts'",
    'const store = new TaskStore(process.argv[1])',
    'await store.acquireExecutionLease(process.argv[2])'
  ].join(';');
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, state, value.id], { cwd: process.cwd() }, (error) => error ? reject(error) : resolve());
  });

  const recovered = await new TaskStore(state).acquireExecutionLease(value.id);
  await recovered.assertOwned();
  await recovered.release();
});

test('TaskStore refuses a symlinked execution-lease directory', async (t) => {
  const state = await tempDir(t, 'operator-task-lease-link-state-');
  const outside = await tempDir(t, 'operator-task-lease-link-outside-');
  const value = task();
  if (!(await makeSymlinkOrSkip(t, outside, path.join(state, 'task-leases'), 'junction'))) return;

  await assert.rejects(
    () => new TaskStore(state).acquireExecutionLease(value.id),
    (error: any) => error?.code === 'TASK_LEASE_CORRUPT' && /real directory/.test(error.message)
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test('TaskStore fails closed on malformed execution-lease ownership', async (t) => {
  const state = await tempDir(t, 'operator-task-lease-corrupt-');
  const value = task();
  const leases = path.join(state, 'task-leases');
  await fs.mkdir(leases, { mode: 0o700 });
  await fs.writeFile(path.join(leases, `${value.id}.json`), JSON.stringify({
    version: 1, taskId: value.id, ownerId: 'forged', pid: process.pid, acquiredAt: new Date().toISOString()
  }), { mode: 0o600 });

  await assert.rejects(
    () => new TaskStore(state).acquireExecutionLease(value.id),
    (error: any) => error?.code === 'TASK_LEASE_CORRUPT' && /ownerId/.test(error.message)
  );
});
