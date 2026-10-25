import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { GitProvider } from '../src/capabilities/git.ts';
import test from 'node:test';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { FilesystemProvider } from '../src/capabilities/filesystem.ts';
import { TaskStore } from '../src/core/task-store.ts';
import { SemanticTaskPlanner, TaskOrchestrator, type TaskPlanner, type TaskPlannerContext } from '../src/core/task-orchestrator.ts';

async function fixture(t: test.TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'c05-reservation-root-')));
  const state = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'c05-reservation-state-')));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(state, { recursive: true, force: true });
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
  const store = new TaskStore(state);
  const permissions = {
    allowedRoots: [root], allowedCapabilities: ['file.list','file.create','file.read','git.status'],
    allowExternalWrites: false, allowSystemChanges: false, allowDestructive: false
  };
  const goal = { kind: 'controlled-file-change' as const, root, path: 'verified.txt', content: 'trusted\n' };
  return { root, state, runtime, store, permissions, goal };
}

test('C05 model pre-call budget is durable before returning a canonical authorized planner step', async t => {
  const f = await fixture(t);
  const builtin = new SemanticTaskPlanner();
  let charged = false, invoked = 0;
  const planner: TaskPlanner = {
    id: 'test.budgeted-local-model',
    supports: goal => goal.kind === 'controlled-file-change',
    async next(context) {
      if (!charged) {
        assert.ok(context.reserveModelBudget);
        await context.reserveModelBudget!(400);
        const recorded = await f.store.get(context.task.id);
        assert.equal(recorded.execution?.modelCallCount, 1);
        assert.equal(recorded.execution?.modelReservedTokens, 400);
        charged = true;
        invoked++;
      }
      return builtin.next(context);
    },
    accept: (context, step, obs) => builtin.accept(context, step, obs),
    fallback: (context, step, obs) => builtin.fallback(context, step, obs)
  };
  const engine = new TaskOrchestrator({
    runtime: f.runtime, store: f.store, permissions: f.permissions, planners: [planner]
  });
  const task = await engine.submit({
    objective: 'Execute only after durable model budget reserve',
    authorizedScope: [f.root], successConditions: ['file verified'], goal: f.goal
  });
  const completed = await engine.run(task.id);
  assert.equal(completed.state, 'VERIFIED', JSON.stringify(completed.failures));
  assert.equal(invoked, 1);
  assert.equal((await new TaskStore(f.state).get(task.id)).execution?.modelReservedTokens, 400);
  assert.equal((await fs.readFile(path.join(f.root, 'verified.txt'), 'utf8')), 'trusted\n');
});

test('C05 uncertain model call remains charged after planner timeout without native dispatch', async t => {
  const f = await fixture(t);
  let invoked = 0, dispatched = 0;
  const planner: TaskPlanner = {
    id: 'test.budgeted-timeout',
    supports: goal => goal.kind === 'controlled-file-change',
    async next(context) {
      await context.reserveModelBudget!(256);
      invoked++;
      return await new Promise<never>(() => {});
    },
    accept() {}
  };
  const engine = new TaskOrchestrator({
    runtime: f.runtime, store: f.store, permissions: f.permissions, planners: [planner],
    executeAction: async (action, profile, context) => {
      dispatched++;
      return await f.runtime.execute(action, profile, context);
    }
  });
  const task = await engine.submit({
    objective: 'Charge potential model usage but never act on timeout',
    authorizedScope: [f.root], successConditions: ['no unsupported execution'],
    goal: f.goal, timeoutMs: 180
  });
  assert.equal((await engine.run(task.id)).state, 'FAILED');
  const restored = await new TaskStore(f.state).get(task.id);
  assert.equal(restored.execution?.modelCallCount, 1);
  assert.equal(restored.execution?.modelReservedTokens, 256);
  assert.equal(invoked, 1);
  assert.equal(dispatched, 0);
});

test('C05 malformed token requests cannot reserve or dispatch a model call', async t => {
  const f = await fixture(t);
  let dispatch = 0;
  const planner: TaskPlanner = {
    id: 'test.bad-budget',
    supports: goal => goal.kind === 'controlled-file-change',
    async next(context) {
      await context.reserveModelBudget!(Number.NaN);
      throw new Error('must not reach model');
    },
    accept() {}
  };
  const engine = new TaskOrchestrator({
    runtime: f.runtime, store: f.store, permissions: f.permissions, planners: [planner],
    executeAction: async (action, profile, ctx) => {
      dispatch++;
      return await f.runtime.execute(action, profile, ctx);
    }
  });
  const task = await engine.submit({
    objective: 'Deny malformed budget',
    authorizedScope: [f.root], successConditions: ['no action'], goal: f.goal
  });
  assert.equal((await engine.run(task.id)).state, 'FAILED');
  assert.equal((await f.store.get(task.id)).execution?.modelCallCount, undefined);
  assert.equal(dispatch, 0);
});

test('C05 settled planner cannot reuse a retained model charging callback', async t => {
  const f = await fixture(t);
  const builtin = new SemanticTaskPlanner();
  let callback: TaskPlannerContext['reserveModelBudget'] | undefined;
  const planner: TaskPlanner = {
    id: 'test.model-budget-reentry',
    supports: goal => goal.kind === 'controlled-file-change',
    next(context) {
      callback ??= context.reserveModelBudget;
      return builtin.next(context);
    },
    accept: (ctx, step, obs) => builtin.accept(ctx, step, obs),
    fallback: (ctx, step, obs) => builtin.fallback(ctx, step, obs)
  };
  const engine = new TaskOrchestrator({
    runtime: f.runtime, store: f.store, permissions: f.permissions, planners: [planner]
  });
  const task = await engine.submit({
    objective: 'Do not charge a model after settled planning',
    authorizedScope: [f.root], successConditions: ['file exists'], goal: f.goal
  });
  assert.equal((await engine.run(task.id)).state, 'VERIFIED');
  assert.ok(callback);
  await assert.rejects(callback!(40), (error: any) => error?.code === 'TASK_PLANNER_ABORTED');
  assert.equal((await f.store.get(task.id)).execution?.modelCallCount, undefined);
});
