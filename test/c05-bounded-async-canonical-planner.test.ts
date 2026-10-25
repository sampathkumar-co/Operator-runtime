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
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'c05-async-root-')));
  const stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'c05-async-state-')));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) =>
    execFile('git', ['init', '--quiet'], { cwd: root }, error => error ? reject(error) : resolve())
  );
  const runtime = new OperatorRuntime().register(new FilesystemProvider({
    allowedRoots: [root],
    windowsPathLeaseExecutable: process.platform === 'win32'
      ? path.resolve('native/windows-path-lease/target/release/operator-windows-path-lease.exe')
      : undefined
  })).register(new GitProvider({ allowedRoots: [root] }));
  const permissions = {
    allowedRoots: [root],
    allowedCapabilities: ['file.list','file.create','file.read','git.status'],
    allowDestructive: false, allowExternalWrites: false, allowSystemChanges: false
  };
  const goal = { kind: 'controlled-file-change' as const, root, path: 'verified.txt', content: 'trusted result\n' };
  return { root, stateDir, runtime, permissions, goal };
}

test('C05 async decisions use existing provider authority and independent task verification', async t => {
  const f = await fixture(t);
  const builtin = new SemanticTaskPlanner();
  let decisions = 0;
  const planner: TaskPlanner = {
    id: 'test.async-canonical',
    supports: goal => goal.kind === 'controlled-file-change',
    async next(context) {
      assert.ok(context.signal, 'Async planner gets Stop/Pause/Cancel cancellation signal');
      decisions++;
      await Promise.resolve();
      return builtin.next(context);
    },
    accept: (context, step, observation) => builtin.accept(context, step, observation),
    fallback: (context, step, observation) => builtin.fallback(context, step, observation)
  };
  const engine = new TaskOrchestrator({
    runtime: f.runtime, store: new TaskStore(f.stateDir), permissions: f.permissions, planners: [planner]
  });
  const proposed = await engine.submit({
    objective: 'Create verified scoped file', authorizedScope: [f.root],
    successConditions: ['verified file content'], goal: f.goal
  });
  const result = await engine.run(proposed.id);
  assert.equal(result.state, 'VERIFIED', JSON.stringify(result.failures));
  assert.ok(decisions >= 3);
  assert.equal(await fs.readFile(path.join(f.root, 'verified.txt'), 'utf8'), 'trusted result\n');
});

test('C05 malformed asynchronous planner choice may be repaired before any provider dispatch', async t => {
  const f = await fixture(t);
  const builtin = new SemanticTaskPlanner();
  let repairs = 0;
  const planner: TaskPlanner = {
    id: 'test.async-repair',
    supports: goal => goal.kind === 'controlled-file-change',
    next(context) {
      if (context.budget.plannerIterations === 1) return Promise.resolve({
        type: 'step', key: 'malformed', title: 'malformed',
        capability: 'file.create', input: null
      } as unknown as PlannerDecision);
      return builtin.next(context);
    },
    async repair(context) {
      repairs++;
      await Promise.resolve();
      return builtin.next(context);
    },
    accept: (context, step, observation) => builtin.accept(context, step, observation)
  };
  const engine = new TaskOrchestrator({
    runtime: f.runtime, store: new TaskStore(f.stateDir), permissions: f.permissions, planners: [planner]
  });
  const task = await engine.submit({
    objective: 'Repair bad async input', authorizedScope: [f.root],
    successConditions: ['content verifies'], goal: f.goal
  });
  assert.equal((await engine.run(task.id)).state, 'VERIFIED');
  assert.equal(repairs, 1);
});

test('C05 unresponsive async planner exhausts deadline without dispatch or repair retry', async t => {
  const f = await fixture(t);
  let dispatched = 0, repairs = 0;
  const planner: TaskPlanner = {
    id: 'test.async-deadline',
    supports: goal => goal.kind === 'controlled-file-change',
    async next() { return await new Promise<PlannerDecision>(() => {}); },
    async repair() { repairs++; throw new Error('do not restart paid model call after timeout'); },
    accept() {}
  };
  const engine = new TaskOrchestrator({
    runtime: f.runtime, store: new TaskStore(f.stateDir), permissions: f.permissions, planners: [planner],
    executeAction: async (action, profile, context) => {
      dispatched++; return await f.runtime.execute(action, profile, context);
    }
  });
  const task = await engine.submit({
    objective: 'Never dispatch stale planner reply', authorizedScope: [f.root],
    successConditions: ['nothing was mutated'], goal: f.goal, timeoutMs: 150
  });
  const result = await engine.run(task.id);
  assert.equal(result.state, 'FAILED');
  assert.equal(dispatched, 0);
  assert.equal(repairs, 0);
  assert.equal(result.execution?.records.length, 0);
});

test('C05 Pause interrupts an uncooperative async planner without starting any side effect', async t => {
  const f = await fixture(t);
  let entered!: () => void;
  const planning = new Promise<void>(resolve => { entered = resolve; });
  let dispatched = 0;
  const planner: TaskPlanner = {
    id: 'test.async-pause',
    supports: goal => goal.kind === 'controlled-file-change',
    async next() { entered(); return await new Promise<PlannerDecision>(() => {}); },
    accept() {}
  };
  const engine = new TaskOrchestrator({
    runtime: f.runtime, store: new TaskStore(f.stateDir), permissions: f.permissions, planners: [planner],
    executeAction: async (action, profile, context) => {
      dispatched++; return await f.runtime.execute(action, profile, context);
    }
  });
  const task = await engine.submit({
    objective: 'Pause before model planning dispatch', authorizedScope: [f.root],
    successConditions: ['no side effects'], goal: f.goal
  });
  const running = engine.run(task.id);
  await planning;
  await engine.pause(task.id);
  assert.equal((await running).state, 'PAUSED');
  assert.equal(dispatched, 0);
});
