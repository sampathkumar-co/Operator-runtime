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
import { taskDecisionBudget } from '../src/core/task-decision-budget.ts';
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
    ? { schemaVersion: 2, domain: 'browser', channel: 'semantic', capability: 'project.inspect',
        epistemicStatus: 'UNKNOWN', ambiguous: false,
        observedAt: new Date(TIME - 1000).toISOString() }
    : { schemaVersion: 2, domain: 'project', channel: 'semantic', capability: 'project.inspect',
        epistemicStatus: 'KNOWN', ambiguous: false,
        observedAt: new Date(TIME - (observationChoice === 'stale' ? 180_000 : 1000)).toISOString() };
  return {
    task: {
      id: 'planner-task-1', userObjective: 'SECRET_USER_OBJECTIVE',
      authorizedScope: ['/SECRET_PROJECT_PATH'], prohibitedScope: ['SECRET_PROHIBITED_SCOPE'],
      successConditions: ['SECRET_SUCCESS_CONDITION'], nodes: [], evidence: [], failures: [],
      execution: {
        plannerState: { durablePlan: plan }, records: [{
          state: 'SUCCEEDED', observation, capability: 'project.inspect',
          risk: 'read',
          startedAt: new Date(TIME - 2000).toISOString(),
          finishedAt: new Date(TIME - 500).toISOString(),
          actionId: 'prior-action', stepKey: 'autonomous:0:verify'
        }]
      }
    } as unknown as TaskPlannerContext['task'],
    goal,
    budget: { maxSteps: 20, usedSteps: 1, remainingSteps: 19,
      plannerIterations: 2, preDispatchReobserves: 0, dispatchedActions: 1,
      maxAttemptsPerStep: 2, activeDeadlineMsRemaining: 1000 },
    recentEvents: [], intelligence: {} as any, decisionBudget: {} as any,
    signal: new AbortController().signal,
    reserveModelBudget: async () => {}
  };
}

function response(index: number): typeof fetch {
  return (async () => new Response(JSON.stringify({ response: JSON.stringify({ index }) }), { status: 200 })) as typeof fetch;
}

test('durable model budget reflects requests and prevents silent zero-usage reporting', () => {
  const used = taskDecisionBudget({
    schemaVersion: 1, plannerId: 'operator.autonomous-workflow.v1',
    goalKind: 'autonomous-workflow', plannerState: {}, maxSteps: 2,
    maxAttemptsPerStep: 1, timeoutMs: 30000, stepCount: 0, records: [],
    modelCallCount: 4, modelReservedTokens: 250
  }, Date.now());
  assert.equal(used.modelCalls.used, 4);
  assert.equal(used.modelCalls.remaining, 0);
  assert.equal(used.tokens.used, 250);
  assert.equal(used.tokens.remaining, 199750);
});

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
  let reservations = 0;
  ctx.reserveModelBudget = async maxTokens => {
    reservations++;
    assert.ok(maxTokens > 64 && maxTokens < 10_000);
  };
  const decision = await planner.next(ctx);
  assert.equal(reservations, 1);
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
    runtime, store: new TaskStore(state), permissions, planners: [planner]
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
  assert.equal(finished.execution!.modelCallCount, 1);
  assert.ok((finished.execution!.modelReservedTokens ?? 0) > 64);
  const reloaded = await new TaskStore(state).get(submitted.id);
  assert.equal(reloaded.execution?.modelCallCount, 1);
  assert.equal(reloaded.execution?.modelReservedTokens, finished.execution!.modelReservedTokens);
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

test('missing durable reservation never permits optional model invocation', async () => {
  let calls = 0;
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'local-planner:latest', now: () => TIME,
    fetchFn: (async () => { calls++; return new Response('x'); }) as typeof fetch
  });
  const ctx = context();
  delete ctx.reserveModelBudget;
  await assert.rejects(() => planner.next(ctx),
    (error: any) => error?.code === 'TASK_MODEL_BUDGET_UNAVAILABLE');
  assert.equal(calls, 0);
});

test('C05 provider-neutral injected ranker sees only preauthorized candidates and safe metadata', async () => {
  let invoked = 0, reserved = 0;
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'trusted-private-provider',
    now: () => TIME,
    fetchFn: (async () => { throw new Error('Local transport must not run when injected ranker is set'); }) as typeof fetch,
    ranker: { async select(input) {
      invoked++;
      assert.equal(input.modelId, 'trusted-private-provider');
      assert.equal(input.candidateCount, 2);
      assert.ok(input.signal instanceof AbortSignal);
      for (const forbidden of ['SECRET_', '/approved-project', 'private.example']) {
        assert.equal(input.prompt.includes(forbidden), false);
      }
      return 1;
    } }
  });
  const ctx = context();
  ctx.reserveModelBudget = async () => { reserved++; };
  const decision = await planner.next(ctx);
  assert.equal(invoked, 1);
  assert.equal(reserved, 1);
  assert.equal(decision.type, 'step');
  if (decision.type === 'step') assert.equal(decision.key, 'autonomous:2:observe');
});

test('C05 untrusted injected ranker cannot fabricate an action or select out of bound candidate', async () => {
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'trusted-private-provider', now: () => TIME,
    ranker: { async select() { return 99; } }
  });
  const ctx = context();
  await assert.rejects(() => planner.next(ctx),
    (error: any) => error?.code === 'TASK_MODEL_SUBGOAL_INVALID');
  assert.equal(ctx.task.execution!.plannerState.activeSubgoalId, undefined);
});

test('C05 provider-neutral inference is bounded even if an injected provider ignores AbortSignal', async () => {
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'trusted-private-provider', now: () => TIME,
    ranker: { async select() { return await new Promise<number>(() => {}); } }
  });
  const ctx = context();
  ctx.budget.activeDeadlineMsRemaining = 30;
  await assert.rejects(() => planner.next(ctx),
    (error: any) => error?.code === 'TASK_MODEL_SUBGOAL_TIMEOUT');
  assert.equal(ctx.task.execution!.plannerState.activeSubgoalId, undefined);
});


test('C05 explicit loopback composer inserts only one source-bound read-only verification checkpoint', async () => {
  const ctx = context();
  const state = ctx.task.execution!.plannerState;
  const plan = state.durablePlan as ReturnType<typeof createDurableTaskPlan>;
  for (const step of plan.subgoals) step.resourceScope = ['/SECRET_PROJECT_PATH'];
  const observation = ctx.task.execution!.records[0]!.observation!;
  observation.stateVersion = 'a'.repeat(64);
  ctx.capabilitySchemas = [{ provider: 'project', stepKey: 'setup', action: 'verify',
    capability: 'project.inspect', risk: 'read', inputSchemaVersion: 1,
    inputMaxBytes: 1024, cancellation: 'required', resourceKinds: ['project'] } as any];
  let modelCalls = 0, reservations = 0;
  ctx.reserveModelBudget = async maxTokens => { reservations++; assert.ok(maxTokens > 100 && maxTokens < 10000); };
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'local-model:latest', now: () => TIME, enableLoopbackComposition: true,
    fetchFn: (async (_url, init) => {
      modelCalls++;
      const prompt = String(JSON.parse(String(init?.body)).prompt);
      for (const secret of ['SECRET_', '/SECRET_PROJECT_PATH', 'private.example']) {
        assert.equal(prompt.includes(secret), false, 'untrusted prompt contained protected task information');
      }
      if (prompt.includes('Fresh observation reference:')) {
        const ref = prompt.match(/Fresh observation reference: ([a-f0-9]{64})/)?.[1];
        assert.ok(ref, 'composer receives an opaque observed-state reference');
        return new Response(JSON.stringify({ response: JSON.stringify({
          operation: 'insert_checkpoint', observationRef: ref, beforeIndex: 0, schemaIndex: 0
        }) }), { status: 200 });
      }
      return new Response(JSON.stringify({ response: '{"index":0}' }), { status: 200 });
    }) as typeof fetch
  });
  const decision = await planner.next(ctx);
  assert.equal(modelCalls, 2);
  assert.equal(reservations, 2);
  assert.equal((state.durablePlan as typeof plan).revision, 2);
  const inserted = (state.durablePlan as typeof plan).subgoals.filter(s => s.key.startsWith('dynamic-checkpoint:'));
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0]!.execution.action.capability, 'project.inspect');
  assert.deepEqual(inserted[0]!.execution.action.input, {});
  assert.deepEqual(inserted[0]!.successContract.assertions, plan.subgoals[0]!.successContract.assertions);
  assert.equal(decision.type, 'step');
  if (decision.type === 'step') {
    assert.equal(decision.key, 'autonomous:3:observe');
    assert.equal(decision.capability, 'project.inspect');
    assert.deepEqual(decision.input, {});
  }
});

test('C05 local model composer remains disabled unless separately opted in', async () => {
  const ctx = context();
  const state = ctx.task.execution!.plannerState;
  for (const step of state.durablePlan.subgoals) step.resourceScope = ['/SECRET_PROJECT_PATH'];
  ctx.task.execution!.records[0]!.observation!.stateVersion = 'a'.repeat(64);
  ctx.capabilitySchemas = [{ provider: 'project', stepKey: 'setup', action: 'verify',
    capability: 'project.inspect', risk: 'read', inputSchemaVersion: 1,
    inputMaxBytes: 1024, cancellation: 'required', resourceKinds: ['project'] } as any];
  let calls = 0;
  const planner = new LocalModelAutonomousWorkflowPlanner({ model: 'local-model:latest', now: () => TIME,
    fetchFn: (async () => { calls++; return new Response(JSON.stringify({ response: '{"index":0}' }), { status: 200 }); }) as typeof fetch });
  await planner.next(ctx);
  assert.equal(calls, 1, 'default opt-in may rank READY goals but must not compose checkpoints');
  assert.equal(state.durablePlan.revision, 1);
});


test('C05 local model rejects unfinished, truncated or tool-calling decision envelopes', async () => {
  for (const fields of [
    { done: false },
    { done: true, done_reason: 'length' },
    { done: true, done_reason: 'stop', tool_calls: [{ function: { name: 'shell' } }] },
    { done: true, function_call: { name: 'file.write' } }
  ]) {
    let invoked = 0;
    const planner = new LocalModelAutonomousWorkflowPlanner({
      model: 'local-planner:latest', now: () => TIME,
      fetchFn: (async () => {
        invoked++;
        return new Response(JSON.stringify({ response: '{"index":0}', ...fields }), { status: 200 });
      }) as typeof fetch
    });
    const ctx = context();
    await assert.rejects(() => planner.next(ctx),
      (error: any) => error?.code === 'TASK_MODEL_SUBGOAL_INVALID');
    assert.equal(invoked, 1);
    assert.equal(ctx.task.execution!.plannerState.activeSubgoalId, undefined);
  }
});

test('C05 settled local model response remains a bounded read-only subgoal index', async () => {
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'local-planner:latest', now: () => TIME,
    fetchFn: (async () => new Response(JSON.stringify({ response: '{"index":0}', done: true,
      done_reason: 'stop' }), { status: 200 })) as typeof fetch
  });
  const decision = await planner.next(context());
  assert.equal(decision.type, 'step');
  if (decision.type === 'step') assert.equal(decision.key, 'autonomous:1:observe');
});

function composerContext(): TaskPlannerContext {
  const ctx = context();
  const state = ctx.task.execution!.plannerState;
  for (const item of (state.durablePlan as ReturnType<typeof createDurableTaskPlan>).subgoals) item.resourceScope = ['/SECRET_PROJECT_PATH'];
  ctx.task.execution!.records[0]!.observation!.stateVersion = 'a'.repeat(64);
  ctx.capabilitySchemas = [{
    provider: 'project', stepKey: 'setup', action: 'verify',
    capability: 'project.inspect', risk: 'read', inputSchemaVersion: 1,
    inputMaxBytes: 1024, cancellation: 'required', resourceKinds: ['project']
  } as any];
  return ctx;
}

test('C05 injected composer cannot execute getters, symbols, or hidden authority fields', async () => {
  let accessorCalls = 0;
  const unsafe = [
    Object.defineProperties({}, {
      operation: { enumerable: true, get() { accessorCalls++; throw new Error('executed'); } },
      observationRef: { enumerable: true, value: 'a'.repeat(64) }
    }),
    Object.assign({operation: 'none', observationRef: 'a'.repeat(64)},
      { [Symbol('authorization')]: true }),
    Object.defineProperty({ operation: 'none', observationRef: 'a'.repeat(64) },
      'action', { enumerable: false, value: { capability: 'file.write' } }),
    Object.create({operation: 'none'})
  ];
  for (const value of unsafe) {
    const ctx = composerContext();
    let reservations = 0;
    ctx.reserveModelBudget = async () => { reservations++; };
    const planner = new LocalModelAutonomousWorkflowPlanner({
      model: 'injected-safe-model', now: () => TIME,
      composer: { async compose() { return value as any; } }
    });
    await assert.rejects(() => planner.next(ctx), (error: any) =>
      error?.code === 'TASK_MODEL_SUBGOAL_INVALID');
    assert.equal(reservations, 1);
    assert.equal(ctx.task.execution!.plannerState.activeSubgoalId, undefined);
    assert.equal((ctx.task.execution!.plannerState.durablePlan as ReturnType<typeof createDurableTaskPlan>).revision, 1);
  }
  assert.equal(accessorCalls, 0);
});

test('C05 injected composer rejects wrong observed-state ref and fabricated scope', async () => {
  const proposals = [
    { operation: 'insert_checkpoint', observationRef: 'a'.repeat(64), beforeIndex: 0, schemaIndex: 0, action: 'file.write' },
    { operation: 'insert_checkpoint', observationRef: 'b'.repeat(64), beforeIndex: 0, schemaIndex: 0 },
    { operation: 'insert_checkpoint', observationRef: 'a'.repeat(64), beforeIndex: 0, schemaIndex: 99 }
  ];
  for (const bad of proposals) {
    const ctx = composerContext();
    const planner = new LocalModelAutonomousWorkflowPlanner({
      model: 'injected-safe-model', now: () => TIME,
      composer: { async compose() { return bad as any; } }
    });
    await assert.rejects(() => planner.next(ctx), (error: any) =>
      error?.code === 'TASK_MODEL_SUBGOAL_INVALID');
    assert.equal((ctx.task.execution!.plannerState.durablePlan as ReturnType<typeof createDurableTaskPlan>).revision, 1);
    assert.equal(ctx.task.execution!.plannerState.activeSubgoalId, undefined);
  }
});

test('C05 injected composer cannot be invoked for an unauthorized write schema', async () => {
  const ctx = composerContext();
  ctx.capabilitySchemas![0]!.risk = 'write';
  let composeCalls = 0, rankCalls = 0;
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'injected-safe-model', now: () => TIME,
    composer: { async compose() { composeCalls++; throw new Error('must not transmit'); } },
    ranker: { async select() { rankCalls++; return 0; } }
  });
  const result = await planner.next(ctx);
  assert.equal(result.type, 'step');
  assert.equal(composeCalls, 0);
  assert.equal(rankCalls, 1);
  assert.equal((ctx.task.execution!.plannerState.durablePlan as ReturnType<typeof createDurableTaskPlan>).revision, 1);
});

test('C05 Stop rejects composer ignoring cancellation without mutating the durable plan', async () => {
  const ctx = composerContext();
  let invoked!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { invoked = resolve; });
  const gated = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  ctx.signal = controller.signal;
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'injected-safe-model', now: () => TIME,
    composer: { async compose() {
      invoked(); await gated;
      return { operation: 'none', observationRef: 'a'.repeat(64) };
    } }
  });
  const pending = planner.next(ctx);
  await entered;
  controller.abort();
  await assert.rejects(() => pending, (error: any) => error?.code === 'TASK_PLANNER_ABORTED');
  release();
  await Promise.resolve();
  assert.equal((ctx.task.execution!.plannerState.durablePlan as ReturnType<typeof createDurableTaskPlan>).revision, 1);
  assert.equal(ctx.task.execution!.plannerState.activeSubgoalId, undefined);
});


test('C05 READY scheduler never calls the model after an expired slow durable reservation', async () => {
  let calls = 0;
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'gemma3:1b', now: () => TIME,
    fetchFn: (async () => { calls++; return new Response(JSON.stringify({ response: '{"index":1}' })); }) as typeof fetch
  });
  const ctx = context();
  ctx.budget.activeDeadlineMsRemaining = 10;
  ctx.reserveModelBudget = async () => {
    await new Promise(resolve => setTimeout(resolve, 40));
  };
  await assert.rejects(() => planner.next(ctx),
    (e: any) => e?.code === 'TASK_MODEL_SUBGOAL_TIMEOUT');
  await new Promise(resolve => setTimeout(resolve, 55));
  assert.equal(calls, 0);
  assert.equal(ctx.task.execution!.plannerState.activeSubgoalId, undefined);
});

test('C05 READY scheduler Stop interrupts uncooperative durable reservation before a prompt', async () => {
  let calls = 0;
  const abort = new AbortController();
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'gemma3:1b', now: () => TIME,
    fetchFn: (async () => { calls++; return new Response(JSON.stringify({ response: '{"index":1}' })); }) as typeof fetch
  });
  const ctx = context();
  ctx.signal = abort.signal;
  ctx.reserveModelBudget = async () => await new Promise<void>(() => {});
  const running = planner.next(ctx);
  abort.abort();
  await assert.rejects(running, (e: any) => e?.code === 'TASK_PLANNER_ABORTED');
  assert.equal(calls, 0);
  assert.equal(ctx.task.execution!.plannerState.activeSubgoalId, undefined);
});

test('C05 scheduler rejects model URL-shaped identifiers and requires a Stop fence', async () => {
  for (const model of ['https://evil.invalid/m', '/model:tag', 'bad model name', 'owner//bad']) {
    assert.throws(() => new LocalModelAutonomousWorkflowPlanner({ model }),
      (e: any) => e?.code === 'TASK_MODEL_SUBGOAL_INVALID');
  }
  let called = 0;
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'gemma3:1b', now: () => TIME,
    fetchFn: (async () => { called++; return new Response('{}'); }) as typeof fetch
  });
  const ctx = context();
  ctx.signal = undefined;
  await assert.rejects(() => planner.next(ctx),
    (e: any) => e?.code === 'TASK_PLANNER_ABORTED');
  assert.equal(called, 0);
});



test('C05 dynamic checkpoint cannot transmit after a slow durable budget charge expires', async () => {
  const ctx = composerContext();
  const before = ctx.task.execution!.plannerState.durablePlan.revision;
  ctx.budget.activeDeadlineMsRemaining = 10;
  let modelCalls = 0;
  ctx.reserveModelBudget = async () => { await new Promise(resolve => setTimeout(resolve, 40)); };
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'gemma3:1b', now: () => TIME, enableLoopbackComposition: true,
    fetchFn: (async () => { modelCalls++; return new Response('{}'); }) as typeof fetch
  });
  await assert.rejects(() => planner.next(ctx),
    (e: any) => e?.code === 'TASK_MODEL_SUBGOAL_TIMEOUT');
  await new Promise(resolve => setTimeout(resolve, 55));
  assert.equal(modelCalls, 0);
  assert.equal(ctx.task.execution!.plannerState.durablePlan.revision, before);
});

test('C05 Stop interrupts uncooperative dynamic composition reservation without plan mutation', async () => {
  const ctx = composerContext();
  const before = ctx.task.execution!.plannerState.durablePlan.revision;
  const abort = new AbortController();
  ctx.signal = abort.signal;
  ctx.reserveModelBudget = async () => await new Promise<void>(() => {});
  let modelCalls = 0;
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'gemma3:1b', now: () => TIME, enableLoopbackComposition: true,
    fetchFn: (async () => { modelCalls++; return new Response('{}'); }) as typeof fetch
  });
  const running = planner.next(ctx);
  abort.abort();
  await assert.rejects(running, (e: any) => e?.code === 'TASK_PLANNER_ABORTED');
  assert.equal(modelCalls, 0);
  assert.equal(ctx.task.execution!.plannerState.durablePlan.revision, before);
});


test('C05 scheduler refuses model influence when a read receipt is not causally bound', async () => {
  let modelCalls = 0;
  let reservations = 0;
  const planner = new LocalModelAutonomousWorkflowPlanner({
    model: 'local-planner:latest', now: () => TIME,
    fetchFn: (async () => { modelCalls++; throw Error('must not infer from forged receipt'); }) as typeof fetch
  });
  const invalidReads: Array<(ctx: TaskPlannerContext) => void> = [
    ctx => { ctx.task.execution!.records[0]!.risk = 'write'; },
    ctx => { ctx.task.execution!.records[0]!.finishedAt = undefined; },
    ctx => { ctx.task.execution!.records[0]!.startedAt = new Date(TIME - 500).toISOString(); },
    ctx => { ctx.task.execution!.records[0]!.finishedAt = new Date(TIME - 1500).toISOString(); },
    ctx => { ctx.task.execution!.records[0]!.finishedAt = new Date(TIME + 100).toISOString(); },
    ctx => { if (ctx.task.execution!.records[0]!.observation?.schemaVersion === 2) {
      ctx.task.execution!.records[0]!.observation.capability = 'browser.inspect';
    } }
  ];
  for (const [index, mutate] of invalidReads.entries()) {
    const ctx = context();
    ctx.reserveModelBudget = async () => { reservations++; };
    mutate(ctx);
    const decision = await planner.next(ctx);
    assert.equal(decision.type, 'step', 'invalid receipt case ' + index);
    if (decision.type === 'step') {
      assert.equal(decision.key, 'autonomous:1:observe',
        'unproven observation must preserve deterministic scheduler order');
    }
  }
  assert.equal(reservations, 0, 'no durable model-call reservation on an unproven read');
  assert.equal(modelCalls, 0, 'no local-model network call on an unproven read');
});
