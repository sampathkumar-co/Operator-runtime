import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LoopbackOllamaPlanningInfluence
} from '../src/core/local-model-planning-influence.ts';
import type {
  TaskPlanningInfluenceRequest
} from '../src/core/task-orchestrator-contracts.ts';
import type { TaskPlannerEvent, PlannerEventDecision } from '../src/core/task-planner-event.ts';

function request(decision: PlannerEventDecision | undefined, options: { risk?: 'read' | 'write'; timeout?: number } = {}): TaskPlanningInfluenceRequest {
  const recentEvents: TaskPlannerEvent[] = decision ? [{
    kind: decision === 'WAIT' ? 'RESOURCE_BUSY' : decision === 'RECONCILE' ? 'RECONCILIATION_REQUIRED'
      : decision === 'FAIL' ? 'ACTION_SUCCEEDED_BUT_NO_PROGRESS' : 'STALE_TARGET',
    decision, code: 'TEST_RUNTIME_SIGNAL', at: new Date().toISOString(),
    provider: 'verified-runtime', capability: 'file.read',
    reason: 'SENSITIVE_EVENT_BODY_DO_NOT_SEND'
  }] : [];
  return {
    proposalDigest: 'a'.repeat(64), recentEvents, risk: options.risk ?? 'write',
    task: { userObjective: 'SENSITIVE_OBJECTIVE_DO_NOT_SEND', authorizedScope: ['/very/private'] } as any,
    goal: { kind: 'controlled-file-change', root: '/very/private', path: 'secret-key', content: 'TOPSECRET' },
    decision: { type: 'step', key: 'x', title: 'SENSITIVE_TITLE', capability: 'file.create',
      input: { content: 'SECRET_ACTION_INPUT_DO_NOT_SEND' } },
    budget: { maxSteps: 5, usedSteps: 0, remainingSteps: 5, plannerIterations: 2, preDispatchReobserves: 0,
      dispatchedActions: 0, maxAttemptsPerStep: 2, activeDeadlineMsRemaining: options.timeout ?? 1_000 },
    intelligence: {} as any, decisionBudget: {} as any
  };
}

function fakeFetch(command: unknown, observe?: (url: unknown, init?: RequestInit) => void): typeof fetch {
  return (async (url, init) => {
    observe?.(url, init);
    return new Response(JSON.stringify({ response: JSON.stringify(command) }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
}

test('local model advisory is dormant without an actionable verified planner event', async () => {
  let calls = 0;
  const advisor = new LoopbackOllamaPlanningInfluence({
    model: 'local-test:latest',
    fetchFn: fakeFetch({ command: 'WAIT' }, () => { calls++; })
  });
  assert.equal(await advisor.review(request(undefined)), undefined);
  assert.equal(await advisor.review(request('REPAIR')), undefined);
  assert.equal(calls, 0);
});

test('a newer successful provider action resolves stale model-control events', async () => {
  let calls = 0;
  const advisor = new LoopbackOllamaPlanningInfluence({
    model: 'local-test:latest', fetchFn: fakeFetch({ command: 'REOBSERVE' }, () => { calls++; })
  });
  const stale = request('REOBSERVE');
  stale.recentEvents[0]!.at = '2020-01-01T00:00:00.000Z';
  stale.task.execution = { records: [{ state: 'SUCCEEDED', finishedAt: '2020-01-01T00:00:01.000Z' }] } as any;
  assert.equal(await advisor.review(stale), undefined);
  assert.equal(calls, 0);
});

test('uncertain runtime event requires reconciliation without a model call', async () => {
  let calls = 0;
  const advisor = new LoopbackOllamaPlanningInfluence({
    model: 'local-test:latest',
    fetchFn: fakeFetch({ command: 'ALLOW' }, () => { calls++; })
  });
  const result = await advisor.review(request('RECONCILE'));
  assert.equal(result?.command, 'RECONCILE');
  assert.equal(result?.effect, 'CONTROL_ALLOWED');
  assert.equal(result?.proposalDigest, 'a'.repeat(64));
  assert.equal(result?.grantsAuthority, false);
  assert.equal(result?.runtimeVetoRequired, true);
  assert.equal(calls, 0);
});

test('uncertain reconciliation remains blocked even after a later unrelated successful read', async () => {
  let calls = 0;
  const advisor = new LoopbackOllamaPlanningInfluence({
    model: 'local-test:latest',
    fetchFn: fakeFetch({ command: 'ALLOW' }, () => { calls++; })
  });
  const old = request('RECONCILE');
  old.recentEvents[0]!.at = '2026-10-22T09:00:00.000Z';
  old.task.execution = { records: [{
    state: 'SUCCEEDED', capability: 'file.read', finishedAt: '2026-10-22T09:01:00.000Z'
  }] } as any;
  const hold = await advisor.review(old);
  assert.equal(hold?.command, 'RECONCILE');
  assert.equal(hold?.runtimeVetoRequired, true);
  assert.equal(hold?.grantsAuthority, false);
  assert.equal(calls, 0);
});

test('real model advisory request uses fixed loopback and contains no sensitive task or observation text', async () => {
  let calls = 0;
  const advisor = new LoopbackOllamaPlanningInfluence({
    model: 'local-test:latest',
    fetchFn: fakeFetch({ command: 'REOBSERVE' }, (url, init) => {
      calls++;
      assert.equal(url, 'http://127.0.0.1:11434/api/generate');
      assert.equal(init?.redirect, 'error');
      const envelope = JSON.parse(String(init?.body));
      assert.equal(envelope.stream, false);
      assert.equal(envelope.options.temperature, 0);
      assert.ok(envelope.prompt.includes('STALE_TARGET'));
      for (const secret of ['SENSITIVE_OBJECTIVE_DO_NOT_SEND', 'SECRET_ACTION_INPUT_DO_NOT_SEND',
        'SENSITIVE_TITLE', 'SENSITIVE_EVENT_BODY_DO_NOT_SEND', 'TOPSECRET', '/very/private']) {
        assert.equal(envelope.prompt.includes(secret), false, secret + ' reached model prompt');
      }
    })
  });
  const modelRequest = request('REOBSERVE');
  let reservations = 0;
  modelRequest.reserveModelBudget = async maxTokens => {
    reservations++;
    assert.ok(maxTokens >= 80 && maxTokens <= 10_000);
  };
  const result = await advisor.review(modelRequest);
  assert.equal(reservations, 1);
  assert.equal(result?.command, 'OBSERVE');
  assert.equal(result?.effect, 'CONTROL_ALLOWED');
  assert.equal(result?.grantsAuthority, false);
  assert.equal(result?.runtimeVetoRequired, true);
  assert.equal(calls, 1);
});

test('an event-mismatched model veto is logged but never gains control', async () => {
  const advisor = new LoopbackOllamaPlanningInfluence({
    model: 'local-test:latest', fetchFn: fakeFetch({ command: 'WAIT' })
  });
  const result = await advisor.review(request('REOBSERVE'));
  assert.equal(result?.command, 'VERIFY');
  assert.equal(result?.effect, 'CONTROL_BLOCKED');
});

test('model cannot fabricate steps, permissions, or control directives outside a closed schema', async () => {
  const advisor = new LoopbackOllamaPlanningInfluence({
    model: 'local-test:latest', fetchFn: fakeFetch({ command: 'ALLOW', capability: 'file.create', input: { path: '/tmp/evil' } })
  });
  await assert.rejects(() => advisor.review(request('REOBSERVE')),
    (error: any) => error?.code === 'TASK_MODEL_INFLUENCE_INVALID');
  assert.throws(() => new LoopbackOllamaPlanningInfluence({ model: 'unsafe\nmodel' }),
    (error: any) => error?.code === 'TASK_MODEL_INFLUENCE_INVALID');
});

test('uncooperative local model times out and fails closed before dispatch', async () => {
  const advisor = new LoopbackOllamaPlanningInfluence({
    model: 'local-test:latest',
    fetchFn: (async () => await new Promise<Response>(() => {})) as typeof fetch
  });
  await assert.rejects(() => advisor.review(request('REOBSERVE', { timeout: 25 })),
    (error: any) => error?.code === 'TASK_MODEL_INFLUENCE_TIMEOUT');
});

test('model can explicitly permit the existing canonical planner decision, never generate a new one', async () => {
  const advisor = new LoopbackOllamaPlanningInfluence({
    model: 'local-test:latest', fetchFn: fakeFetch({ command: 'ALLOW' })
  });
  assert.equal(await advisor.review(request('REPLAN')), undefined);
});

test('model response body is bounded even when server omits content-length', async () => {
  const advisor = new LoopbackOllamaPlanningInfluence({
    model: 'local-test:latest',
    fetchFn: (async () => new Response('X'.repeat(20_000), { status: 200 })) as typeof fetch
  });
  await assert.rejects(() => advisor.review(request('WAIT')),
    (error: any) => error?.code === 'TASK_MODEL_INFLUENCE_INVALID');
});
