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
    intelligence: {} as any, decisionBudget: {} as any,
    signal: new AbortController().signal, reserveModelBudget: async (_tokens: number) => undefined
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
    (error: any) => error?.code === 'TASK_LOCAL_MODEL_INVALID');
});


test('C05 advisory never contacts local model without durable call reservation', async () => {
  let calls = 0;
  const advisor = new LoopbackOllamaPlanningInfluence({
    model: 'gemma3:1b', fetchFn: fakeFetch({ command: 'WAIT' }, () => { calls++; })
  });
  const missing = request('WAIT');
  missing.reserveModelBudget = undefined;
  await assert.rejects(() => advisor.review(missing),
    (error: any) => error?.code === 'TASK_MODEL_INFLUENCE_INVALID');
  const failed = request('WAIT');
  failed.reserveModelBudget = async () => { throw new Error('durable reservation failed'); };
  await assert.rejects(() => advisor.review(failed), /durable reservation failed/);
  assert.equal(calls, 0);
});

test('C05 Stop fence blocks model request and action influence before transport', async () => {
  let calls = 0;
  const advisor = new LoopbackOllamaPlanningInfluence({
    model: 'gemma3:1b', fetchFn: fakeFetch({ command: 'WAIT' }, () => { calls++; })
  });
  const stopped = request('WAIT');
  stopped.signal = AbortSignal.abort();
  await assert.rejects(() => advisor.review(stopped),
    (error: any) => error?.code === 'TASK_MODEL_INFLUENCE_ABORTED');
  assert.equal(calls, 0);
});

test('C05 model naming rejects URL-shaped advisory identifiers without contacting Ollama', () => {
  for (const model of ['https://host.invalid/test', 'owner//bad', ':latest', 'bad model name']) {
    assert.throws(() => new LoopbackOllamaPlanningInfluence({ model }),
      (error: any) => error?.code === 'TASK_MODEL_INFLUENCE_INVALID');
  }
});

test('C05 model cannot bypass hard reconciliation after later unrelated success', async () => {
  let calls = 0;
  const advisor = new LoopbackOllamaPlanningInfluence({
    model: 'gemma3:1b', fetchFn: fakeFetch({ command: 'ALLOW' }, () => { calls++; })
  });
  const stale = request('RECONCILE');
  stale.task.execution = { records: [
    { state: 'SUCCEEDED', finishedAt: '2026-10-22T10:01:00.000Z' }
  ] } as any;
  stale.recentEvents[0]!.at = '2026-10-22T10:00:00.000Z';
  assert.equal((await advisor.review(stale))?.command, 'RECONCILE');
  assert.equal(calls, 0);
});



test('C05 slow durable reservation never initiates a model call after task deadline', async () => {
  let calls = 0;
  const advisor = new LoopbackOllamaPlanningInfluence({
    model: 'gemma3:1b', fetchFn: fakeFetch({ command: 'WAIT' }, () => { calls++; })
  });
  const input = request('WAIT', { timeout: 10 });
  input.reserveModelBudget = async () => {
    await new Promise(resolve => setTimeout(resolve, 40));
  };
  await assert.rejects(() => advisor.review(input),
    (e: any) => e?.code === 'TASK_MODEL_INFLUENCE_TIMEOUT');
  await new Promise(resolve => setTimeout(resolve, 55));
  assert.equal(calls, 0);
});

test('C05 a hung durable reservation is interruptible by Stop without model dispatch', async () => {
  let calls = 0;
  const controller = new AbortController();
  const advisor = new LoopbackOllamaPlanningInfluence({
    model: 'gemma3:1b', fetchFn: fakeFetch({ command: 'WAIT' }, () => { calls++; })
  });
  const input = request('WAIT', { timeout: 1000 });
  input.signal = controller.signal;
  input.reserveModelBudget = async () => await new Promise<void>(() => {});
  const result = advisor.review(input);
  controller.abort();
  await assert.rejects(result, (e: any) => e?.code === 'TASK_MODEL_INFLUENCE_ABORTED');
  assert.equal(calls, 0);
});

test('C05 advisory understands the five canonical action-risk classes without expanding authority', async () => {
  const seen: string[] = [];
  const advisor = new LoopbackOllamaPlanningInfluence({
    model: 'gemma3:1b',
    fetchFn: fakeFetch({ command: 'WAIT' }, (_url, init) => {
      seen.push(JSON.parse(String(init?.body)).prompt);
    })
  });
  for (const risk of ['read', 'write', 'external', 'system', 'destructive'] as const) {
    const input = request('WAIT');
    input.risk = risk;
    const response = await advisor.review(input);
    assert.equal(response?.command, 'WAIT');
    assert.equal(response?.grantsAuthority, false);
  }
  assert.equal(seen.length, 5);
  for (const risk of ['read', 'write', 'external', 'system', 'destructive']) {
    assert.ok(seen.some(text => text.includes('"risk":"' + risk + '"')));
  }
});

test('C05 valid one-hour task context does not invalidate an eight-second advisory cap', async () => {
  const advisor = new LoopbackOllamaPlanningInfluence({
    model: 'gemma3:1b', fetchFn: fakeFetch({ command: 'ALLOW' })
  });
  const input = request('WAIT', { timeout: 60 * 60_000 });
  assert.equal(await advisor.review(input), undefined);
});


test('C05/C08 advisor rejects executable and sparse event envelopes without inference', async () => {
  let modelCalls = 0;
  let reservations = 0;
  let conversions = 0;
  const advisor = new LoopbackOllamaPlanningInfluence({
    model: 'local-test:latest',
    fetchFn: fakeFetch({ command: 'REOBSERVE' }, () => { modelCalls++; })
  });
  const attacks: Array<(input: TaskPlanningInfluenceRequest) => void> = [
    input => { input.recentEvents = Array(1) as TaskPlannerEvent[]; },
    input => { const source = input.recentEvents[0]!;
      const poisoned: TaskPlannerEvent[] = [];
      Object.defineProperty(poisoned, '0', {
        enumerable: true, get() { conversions++; return source; }
      });
      poisoned.length = 1;
      input.recentEvents = poisoned;
    },
    input => { Object.defineProperty(input.recentEvents[0]!, 'kind', {
      enumerable: true, get() { conversions++; return 'STALE_TARGET'; }
    }); },
    input => { Object.defineProperty(input.recentEvents[0]!, 'decision', {
      enumerable: true, get() { conversions++; return 'REOBSERVE'; }
    }); },
    input => { Object.defineProperty(input.recentEvents[0]!, 'at', {
      enumerable: true, get() { conversions++; return new Date().toISOString(); }
    }); },
    input => { (input.recentEvents as any).at = () => {
      conversions++; return input.recentEvents[0]; }; }
  ];
  for (const mutate of attacks) {
    const req = request('REOBSERVE');
    req.reserveModelBudget = async () => { reservations++; };
    mutate(req);
    await assert.rejects(advisor.review(req), (error: any) =>
      error?.code === 'TASK_MODEL_INFLUENCE_INVALID');
  }
  const malformed = request('REOBSERVE');
  malformed.reserveModelBudget = async () => { reservations++; };
  malformed.recentEvents[0]!.at = 'invalid-date';
  assert.equal(await advisor.review(malformed), undefined);
  assert.equal(conversions, 0, 'no hostile array or event accessors may execute');
  assert.equal(modelCalls, 0, 'no inference from malformed event envelopes');
  assert.equal(reservations, 0, 'no model spend reservations from malformed events');
});
