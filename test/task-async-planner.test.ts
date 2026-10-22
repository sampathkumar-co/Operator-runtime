import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { FilesystemProvider } from '../src/capabilities/filesystem.ts';
import { GitProvider } from '../src/capabilities/git.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { TaskStore } from '../src/core/task-store.ts';
import { SemanticTaskPlanner, TaskOrchestrator, type PlannerDecision, type TaskPlanner } from '../src/core/task-orchestrator.ts';

async function fixture(t: test.TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-async-planner-root-')));
  const state = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-async-planner-state-')));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(state, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => execFile('git', ['init', '--quiet'], { cwd: root }, error => error ? reject(error) : resolve()));
  const runtime = new OperatorRuntime().register(new FilesystemProvider({
    allowedRoots: [root],
    windowsPathLeaseExecutable: process.platform === 'win32'
      ? path.resolve('native/windows-path-lease/target/release/operator-windows-path-lease.exe')
      : undefined
  })).register(new GitProvider({ allowedRoots: [root] }));
  const permissions = { allowedRoots: [root], allowedCapabilities: ['file.list', 'file.create', 'file.read', 'git.status'],
    allowDestructive: false, allowExternalWrites: false, allowSystemChanges: false };
  const goal = { kind: 'controlled-file-change' as const, root, path: 'verified.txt', content: 'fresh decision\n' };
  return { root, state, runtime, permissions, goal };
}

test('asynchronous planner decisions execute through canonical providers and independent verification', async t => {
  const f = await fixture(t);
  const builtin = new SemanticTaskPlanner();
  let calls = 0;
  const planner: TaskPlanner = {
    id: 'test.async-canonical',
    supports: goal => goal.kind === 'controlled-file-change',
    async next(context) {
      assert.ok(context.signal, 'task cancellation must reach an asynchronous model planner');
      ++calls;
      await Promise.resolve();
      return builtin.next(context);
    },
    accept: (context, step, observation) => builtin.accept(context, step, observation),
    fallback: (context, step, observation) => builtin.fallback(context, step, observation)
  };
  const orchestrator = new TaskOrchestrator({ runtime: f.runtime, store: new TaskStore(f.state),
    permissions: f.permissions, planners: [planner] });
  const submitted = await orchestrator.submit({
    objective: 'Create a scoped file and verify its content.', authorizedScope: [f.root],
    successConditions: ['the file exists with matching content'], goal: f.goal
  });
  const finished = await orchestrator.run(submitted.id);
  assert.equal(finished.state, 'VERIFIED', JSON.stringify({ records: finished.execution?.records.map(r => ({ key: r.stepKey, state: r.state, errorCode: r.errorCode })), evidence: finished.evidence.slice(-4) }));
  assert.ok(calls >= 4);
  assert.equal(await fs.readFile(path.join(f.root, 'verified.txt'), 'utf8'), 'fresh decision\n');
  assert.ok(finished.execution?.records.every(record => record.state === 'SUCCEEDED'));
});

test('invalid async decision is repaired before any action reaches the provider', async t => {
  const f = await fixture(t);
  const builtin = new SemanticTaskPlanner();
  let repairs = 0;
  let dispatches = 0;
  const planner: TaskPlanner = {
    id: 'test.async-repair',
    supports: goal => goal.kind === 'controlled-file-change',
    async next(context) {
      if (context.budget.plannerIterations === 1) return { type: 'step', key: 'invalid', title: 'invalid',
        capability: 'file.create', input: null } as unknown as PlannerDecision;
      return builtin.next(context);
    },
    async repair(context, _bad, issue) {
      ++repairs;
      assert.match(issue, /input must be a structured object/);
      return builtin.next(context);
    },
    accept: (context, step, observation) => builtin.accept(context, step, observation),
    fallback: (context, step, observation) => builtin.fallback(context, step, observation)
  };
  const orchestrator = new TaskOrchestrator({ runtime: f.runtime, store: new TaskStore(f.state),
    permissions: f.permissions, planners: [planner],
    executeAction: async (action, profile, context) => {
      ++dispatches;
      return await f.runtime.execute(action, profile, context);
    }
  });
  const submitted = await orchestrator.submit({
    objective: 'Repair malformed model decision safely.', authorizedScope: [f.root],
    successConditions: ['the authorized file content is verified'], goal: f.goal
  });
  const finished = await orchestrator.run(submitted.id);
  assert.equal(finished.state, 'VERIFIED', JSON.stringify({ records: finished.execution?.records.map(r => ({ key: r.stepKey, state: r.state, errorCode: r.errorCode })), evidence: finished.evidence.slice(-4) }));
  assert.equal(repairs, 1);
  assert.equal(dispatches, finished.execution?.records.length);
  assert.ok(finished.evidence.some(item => item.kind === 'planner_repair'));
});

test('unresponsive asynchronous planner times out without dispatching side effects', async t => {
  const f = await fixture(t);
  let dispatches = 0;
  const planner: TaskPlanner = {
    id: 'test.async-timeout',
    supports: goal => goal.kind === 'controlled-file-change',
    async next() { return await new Promise<PlannerDecision>(() => {}); },
    accept() {},
    async repair() { throw new Error('timeout must not trigger another paid model call'); }
  };
  const orchestrator = new TaskOrchestrator({ runtime: f.runtime, store: new TaskStore(f.state),
    permissions: f.permissions, planners: [planner],
    executeAction: async (action, profile, context) => {
      ++dispatches;
      return await f.runtime.execute(action, profile, context);
    }
  });
  const submitted = await orchestrator.submit({
    objective: 'Never dispatch from a stale model output.', authorizedScope: [f.root],
    successConditions: ['no unauthorized file change'], goal: f.goal, timeoutMs: 150
  });
  const finished = await orchestrator.run(submitted.id);
  assert.equal(finished.state, 'FAILED');
  assert.equal(dispatches, 0);
  assert.equal(finished.execution?.records.length, 0);
  await assert.rejects(() => fs.stat(path.join(f.root, 'verified.txt')), { code: 'ENOENT' });
});

test('pause aborts an uncooperative pending planner without any provider dispatch', async t => {
  const f = await fixture(t);
  let entered!: () => void;
  const planning = new Promise<void>(resolve => { entered = resolve; });
  let dispatches = 0;
  const planner: TaskPlanner = {
    id: 'test.async-pause',
    supports: goal => goal.kind === 'controlled-file-change',
    next: async () => {
      entered();
      return await new Promise<PlannerDecision>(() => {});
    },
    accept() {}
  };
  const orchestrator = new TaskOrchestrator({ runtime: f.runtime, store: new TaskStore(f.state),
    permissions: f.permissions, planners: [planner],
    executeAction: async (action, profile, context) => {
      ++dispatches;
      return await f.runtime.execute(action, profile, context);
    }
  });
  const submitted = await orchestrator.submit({
    objective: 'Pause the model before any filesystem mutation.', authorizedScope: [f.root],
    successConditions: ['no side effect occurs'], goal: f.goal
  });
  const running = orchestrator.run(submitted.id);
  await planning;
  await orchestrator.pause(submitted.id);
  const paused = await running;
  assert.equal(paused.state, 'PAUSED');
  assert.equal(dispatches, 0);
  await assert.rejects(() => fs.stat(path.join(f.root, 'verified.txt')), { code: 'ENOENT' });
});

test('pause also interrupts an asynchronous malformed-decision repair before dispatch', async t => {
  const f = await fixture(t);
  let startedRepair!: () => void;
  const repairing = new Promise<void>(resolve => { startedRepair = resolve; });
  let dispatches = 0;
  const planner: TaskPlanner = {
    id: 'test.async-repair-pause',
    supports: goal => goal.kind === 'controlled-file-change',
    next: () => ({ type: 'step', key: 'bad', title: 'bad', capability: 'file.create', input: null }) as unknown as PlannerDecision,
    async repair() {
      startedRepair();
      return await new Promise<PlannerDecision>(() => {});
    },
    accept() {}
  };
  const orchestrator = new TaskOrchestrator({ runtime: f.runtime, store: new TaskStore(f.state),
    permissions: f.permissions, planners: [planner],
    executeAction: async (action, profile, context) => {
      ++dispatches;
      return await f.runtime.execute(action, profile, context);
    }
  });
  const submitted = await orchestrator.submit({
    objective: 'Pause before repair creates a file.', authorizedScope: [f.root],
    successConditions: ['no mutation'], goal: f.goal
  });
  const running = orchestrator.run(submitted.id);
  await repairing;
  await orchestrator.pause(submitted.id);
  assert.equal((await running).state, 'PAUSED');
  assert.equal(dispatches, 0);
  await assert.rejects(() => fs.stat(path.join(f.root, 'verified.txt')), { code: 'ENOENT' });
});
