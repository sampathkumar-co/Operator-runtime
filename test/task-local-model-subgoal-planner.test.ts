import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FilesystemProvider } from '../src/capabilities/filesystem.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { TaskOrchestrator } from '../src/core/task-orchestrator.ts';
import { TaskStore } from '../src/core/task-store.ts';
import test from 'node:test';
import { LocalModelAutonomousWorkflowPlanner } from '../src/core/local-model-subgoal-planner.ts';
import { createDurableTaskPlan } from '../src/core/task-plan.ts';
import type { SemanticTaskGoal, TaskPlannerContext } from '../src/core/task-orchestrator-contracts.ts';

const TIME = Date.parse('2026-10-22T08:00:30.000Z');
const goal: Extract<SemanticTaskGoal, { kind: 'autonomous-workflow' }> = {
  kind: 'autonomous-workflow', roots: ['/approved-project'],
  steps: [
    {
      key: 'setup', title: 'SECRET_INITIAL_TASK', dependsOn: [],
      observe: { capability: 'project.inspect', input: { path: '/SECRET_PROJECT_PATH' } },
      action: { capability: 'project.command.run', input: { path: '/SECRET_PROJECT_PATH', commandId: 'lint' } },
      verify: { capability: 'project.inspect', input: {}, assertions: [{ path: 'ok', op: 'eq', value: true }] as any }
    },
    {
      key: 'second', title: 'SECRET_SECOND_TASK', dependsOn: ['setup'],
      observe: { capability: 'browser.inspect', input: { url: 'https://private.example/SECRET_PAGE' } },
      action: { capability: 'browser.navigate', input: { url: 'https://private.example/SECRET_PAGE' } },
      verify: { capability: 'browser.inspect', input: {}, assertions: [{ path: 'ok', op: 'eq', value: true }] as any }
    },
    {
      key: 'third', title: 'SECRET_THIRD_TASK', dependsOn: ['setup'],
      observe: { capability: 'git.status', input: { cwd: '/SECRET_PROJECT_PATH' } },
      action: { capability: 'project.command.run', input: { path: '/SECRET_PROJECT_PATH', commandId: 'test' } },
      verify: { capability: 'git.status', input: {}, assertions: [{ path: 'ok', op: 'eq', value: true }] as any }
    }
  ]
};

function context(options: { observation?: 'fresh' | 'stale' | 'unknown'; verifiedSetup?: boolean } = {}): TaskPlannerContext {
  const observationChoice = options.observation ?? 'fresh';
  const verifiedSetup = options.verifiedSetup ?? true;
  const plan = createDurableTaskPlan({
    taskId: 'planner-task-1', objective: 'SECRET_USER_OBJECTIVE',
    constraints: ['authorized:/SECRET_PROJECT_PATH'],
    finalSuccessConditions: ['SECRET_SUCCESS_CONDITION'],
    steps: goal.steps, now: new Date(TIME - 10_000).toISOString()
  });
  if (verifiedSetup) plan.subgoals[0]!.status = 'VERIFIED';
  const observation = observationChoice === 'unknown'
    ? { schemaVersion: 2, domain: 'browser', channel: 'semantic', epistemicStatus: 'UNKNOWN', ambiguous: false,
        observedAt: new Date(TIME - 1000).toISOString() }
    : { schemaVersion: 2, domain: 'project', channel: 'semantic', epistemicStatus: 'KNOWN', ambiguous: false,
        observedAt: new Date(TIME - (observationChoice === 'stale' ? 180_000 : 1000)).toISOString() };
  return {
    task: {
      id: 'planner-task-1', userObjective: 'SECRET_USER_OBJECTIVE',
      authorizedScope: ['/SECRET_PROJECT_PATH'], prohibitedScope: ['SECRET_PROHIBITED_SCOPE'],
      successConditions: ['SECRET_SUCCESS_CONDITION'], nodes: [], evidence: [], failures: [],
      execution: {
        plannerState: { durablePlan: plan }, records: [{
          state: 'SUCCEEDED', observation, capability: 'project.inspect',
          actionId: 'prior-action', stepKey: 'autonomous:0:verify'
        }]
      }
    } as unknown as TaskPlannerContext['task'],
    goal,
    budget: { maxSteps: 20, usedSteps: 1, remainingSteps: 19,
      plannerIterations: 2, preDispatchReobserves: 0, dispatchedActions: 1,
      maxAttemptsPerStep: 2, activeDeadlineMsRemaining: 1000 },
    recentEvents: [], intelligence: {} as any, decisionBudget: {} as any
  };
}

function response(index: number): typeof fetch {
  return (async () => new Response(JSON.stringify({ response: JSON.stringify({ index }) }), { status: 200 })) as typeof fetch;
}

test('model chooses one READY subgoal after fresh verified observation; delegate still owns tools', async () => {
  let calls = 0;
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'local-planner:latest', now: () => TIME,
    fetchFn: (async (url, init) => {
      calls++;
      assert.equal(url, 'http://127.0.0.1:11434/api/generate');
      assert.equal(init?.redirect, 'error');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.stream, false);
      assert.equal(body.options.temperature, 0);
      for (const secret of ['SECRET_', 'private.example', '/approved-project', '/SECRET_PROJECT_PATH']) {
        assert.equal(String(body.prompt).includes(secret), false, secret + ' was leaked to model');
      }
      assert.match(body.prompt, /"index":1/);
      return new Response(JSON.stringify({ response: '{"index":1}' }), { status: 200 });
    }) as typeof fetch
  });
  const ctx = context();
  const decision = await planner.next(ctx);
  assert.equal(decision.type, 'step');
  if (decision.type === 'step') {
    assert.equal(decision.key, 'autonomous:2:observe');
    assert.equal(decision.capability, 'git.status');
    assert.deepEqual(decision.input, { cwd: '/SECRET_PROJECT_PATH' });
  }
  assert.equal(calls, 1);
  const active = ctx.task.execution!.plannerState.activeSubgoalId;
  assert.equal(typeof active, 'string');
});

test('before verified observation the planner uses existing deterministic order, not model', async () => {
  let calls = 0;
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'local-planner:latest', now: () => TIME,
    fetchFn: (async () => { calls++; return new Response('error'); }) as typeof fetch
  });
  const ctx = context({ verifiedSetup: false });
  const result = await planner.next(ctx);
  assert.equal(result.type, 'step');
  if (result.type === 'step') assert.equal(result.key, 'autonomous:0:observe');
  assert.equal(calls, 0);
});

test('stale or uncertain observations never trigger the AI scheduler', async () => {
  let calls = 0;
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'local-planner:latest', now: () => TIME,
    fetchFn: (async () => { calls++; return new Response('error'); }) as typeof fetch
  });
  for (const status of ['stale', 'unknown'] as const) {
    const decision = await planner.next(context({ observation: status }));
    assert.equal(decision.type, 'step');
    if (decision.type === 'step') assert.equal(decision.key, 'autonomous:1:observe');
  }
  assert.equal(calls, 0);
});

test('model selecting any index outside the ready-set fails before any action is issued', async () => {
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'local-planner:latest', now: () => TIME, fetchFn: response(10)
  });
  const ctx = context();
  await assert.rejects(() => planner.next(ctx), (error: any) => error?.code === 'TASK_MODEL_SUBGOAL_INVALID');
  assert.equal(ctx.task.execution!.plannerState.activeSubgoalId, undefined);
});

test('model cannot return tools or permissions inside selected-index schema', async () => {
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'local-planner:latest', now: () => TIME,
    fetchFn: (async () => new Response(JSON.stringify({ response: JSON.stringify({
      index: 0, action: { capability: 'file.write', input: { path: '/evil' } }
    }) }))) as typeof fetch
  });
  await assert.rejects(() => planner.next(context()), (error: any) => error?.code === 'TASK_MODEL_SUBGOAL_INVALID');
});

test('uncooperative local model times out without choosing a subgoal', async () => {
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'local-planner:latest', now: () => TIME,
    fetchFn: (async () => await new Promise<Response>(() => {})) as typeof fetch
  });
  const ctx = context();
  ctx.budget.activeDeadlineMsRemaining = 20;
  await assert.rejects(() => planner.next(ctx), (error: any) => error?.code === 'TASK_MODEL_SUBGOAL_TIMEOUT');
  assert.equal(ctx.task.execution!.plannerState.activeSubgoalId, undefined);
});

test('integration: model reorders two READY filesystem subgoals after genuine verification', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-model-ready-root-')));
  const state = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-model-ready-state-')));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(state, { recursive: true, force: true });
  });
  const provider = new FilesystemProvider({
    allowedRoots: [root],
    windowsPathLeaseExecutable: process.platform === 'win32'
      ? path.resolve('native/windows-path-lease/target/release/operator-windows-path-lease.exe')
      : undefined
  });
  const runtime = new OperatorRuntime().register(provider);
  const permissions = {
    allowedRoots: [root], allowedCapabilities: ['file.list', 'file.create', 'file.info'],
    allowExternalWrites: false, allowSystemChanges: false, allowDestructive: false
  };
  const steps = [
    { key: 'setup', dependsOn: [] },
    { key: 'second', dependsOn: ['setup'] },
    { key: 'third', dependsOn: ['setup'] }
  ].map(({ key, dependsOn }) => {
    const target = path.join(root, key + '.txt');
    const data = 'data for ' + key;
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    return {
      key, title: key, dependsOn,
      observe: { capability: 'file.list', input: { path: root } },
      action: { capability: 'file.create', input: { path: target, content: data } },
      verify: { capability: 'file.info', input: { path: target },
        assertions: [{ path: 'sha256', operator: 'equals' as const, value: sha256 }] }
    };
  });
  let modelCalls = 0;
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'test-local:latest',
    fetchFn: (async () => {
      modelCalls++;
      return new Response(JSON.stringify({ response: '{"index":1}' }), { status: 200 });
    }) as typeof fetch
  });
  const orchestrator = new TaskOrchestrator({
    runtime, store: new TaskStore(state), permissions, autonomousPlanner: planner
  });
  const submitted = await orchestrator.submit({
    objective: 'Verify three scoped file outputs; reorder independent subgoals after fresh observations.',
    authorizedScope: [root],
    successConditions: ['every output has the expected SHA-256'],
    maxSteps: 20,
    goal: { kind: 'autonomous-workflow', roots: [root], steps }
  });
  const finished = await orchestrator.run(submitted.id);
  assert.equal(finished.state, 'VERIFIED', JSON.stringify(finished.failures));
  assert.equal(modelCalls, 1);
  const order = finished.execution!.records.map(record => record.stepKey);
  assert.deepEqual(order.slice(0,4), [
    'autonomous:0:observe', 'autonomous:0:action',
    'autonomous:0:verify', 'autonomous:2:observe'
  ]);
  assert.deepEqual(order.slice(6), [
    'autonomous:1:observe', 'autonomous:1:action', 'autonomous:1:verify'
  ]);
  for (const name of ['setup', 'second', 'third']) {
    assert.equal(await fs.readFile(path.join(root, name + '.txt'), 'utf8'), 'data for ' + name);
  }
  const plan = finished.execution!.plannerState.durablePlan as any;
  assert.equal(plan.subgoals.every((item: any) => item.status === 'VERIFIED'), true);
  assert.ok(finished.execution!.records.every(record => record.observation?.schemaVersion === 2));
});

test('Pause/Cancel discards delayed model choice even if mocked transport ignores AbortSignal', async () => {
  let entered!: () => void;
  let release!: () => void;
  const sent = new Promise<void>(resolve => { entered = resolve; });
  const gated = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'local-planner:latest', now: () => TIME,
    fetchFn: (async () => {
      entered();
      await gated; // deliberately ignores the AbortSignal like an uncooperative model
      return new Response(JSON.stringify({ response: '{"index":1}' }), { status: 200 });
    }) as typeof fetch
  });
  const ctx = context();
  ctx.signal = controller.signal;
  const planning = planner.next(ctx);
  await sent;
  controller.abort();
  await assert.rejects(() => planning, (error: any) => error?.code === 'TASK_PLANNER_ABORTED');
  release();
  await Promise.resolve();
  assert.equal(ctx.task.execution!.plannerState.activeSubgoalId, undefined);
});
