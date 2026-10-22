import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LoopbackOllamaTaskGoalInterpreter, validateTaskGoalProposal } from '../src/core/task-goal-interpreter.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { TaskOrchestrator } from '../src/core/task-orchestrator.ts';
import { TaskStore } from '../src/core/task-store.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

const approved = { objective: 'Open the approved page', approvedRoots: [], approvedBrowserOrigins: ['https://example.test'] };
const browser = { goal: { kind: 'browser-navigation', url: 'https://example.test/guide' }, successConditions: ['Page URL is observed'] };

test('untrusted model proposal must be within user-selected browser origin', () => {
  assert.deepEqual(validateTaskGoalProposal(browser, approved), browser);
  assert.throws(() => validateTaskGoalProposal({ ...browser, goal: { kind: 'browser-navigation', url: 'https://evil.test/' } }, approved),
    (error: any) => error?.code === 'TASK_PROPOSAL_SCOPE_DENIED');
  assert.throws(() => validateTaskGoalProposal({ ...browser, goal: { kind: 'browser-navigation', url: 'http://username:password@example.test/' } }, approved),
    (error: any) => error?.code === 'TASK_PROPOSAL_INVALID');
  assert.throws(() => validateTaskGoalProposal({ ...browser, goal: { kind: 'browser-navigation', url: 'https://example.test/', targetId: 'fabricated-tab' } }, approved),
    (error: any) => error?.code === 'TASK_PROPOSAL_INVALID');
  assert.throws(() => validateTaskGoalProposal({ ...browser, goal: { kind: 'browser-navigation', url: 'https://example.test/', run: true } }, approved),
    (error: any) => error?.code === 'TASK_PROPOSAL_INVALID');
  assert.throws(() => validateTaskGoalProposal({ ...browser, goal: { kind: 'controlled-file-change', root: 'C:/', path: 'x', content: 'bad' } }, approved),
    (error: any) => error?.code === 'TASK_PROPOSAL_INVALID');
});

test('model project command cannot infer new trusted root', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-propose-')));
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-propose-outside-')));
  t.after(() => Promise.allSettled([fs.rm(root, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  const request = { objective: 'Run tests', approvedRoots: [root], approvedBrowserOrigins: [] };
  const proposal = { goal: { kind: 'trusted-project-command', root, commandKind: 'test' }, successConditions: ['Test exit code is recorded'] };
  assert.deepEqual(validateTaskGoalProposal(proposal, request), proposal);
  assert.throws(() => validateTaskGoalProposal({ ...proposal, goal: { ...proposal.goal, root: outside } }, request),
    (error: any) => error?.code === 'TASK_PROPOSAL_SCOPE_DENIED');
  assert.throws(() => validateTaskGoalProposal({ ...proposal, goal: { ...proposal.goal, commandKind: 'arbitrary-shell' } }, request),
    (error: any) => error?.code === 'TASK_PROPOSAL_INVALID');
});

test('model may propose two to four scoped sequential steps but cannot invent execution authority', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-propose-sequence-')));
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-propose-sequence-outside-')));
  t.after(() => Promise.allSettled([
    fs.rm(root, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })
  ]));
  const request = { objective: 'Inspect approved site then test project', approvedRoots: [root], approvedBrowserOrigins: ['https://example.test'] };
  const steps = [
    { kind: 'browser-navigation', url: 'https://example.test/docs' },
    { kind: 'trusted-project-command', root, commandKind: 'test' }
  ];
  const response = { goal: { kind: 'semantic-workflow', steps }, successConditions: ['Both steps are verified by the runtime'] };
  assert.deepEqual(validateTaskGoalProposal(response, request), response);
  assert.throws(() => validateTaskGoalProposal({ ...response, goal: { kind: 'semantic-workflow', steps: [...steps, ...steps, ...steps] } }, request),
    (error: any) => error?.code === 'TASK_PROPOSAL_INVALID');
  assert.throws(() => validateTaskGoalProposal({ ...response, goal: { kind: 'semantic-workflow', steps: [steps[0], steps[0]] } }, request),
    (error: any) => error?.code === 'TASK_PROPOSAL_INVALID');
  assert.throws(() => validateTaskGoalProposal({ ...response, goal: { kind: 'semantic-workflow',
    steps: [steps[0], { kind: 'trusted-project-command', root: outside, commandKind: 'test' }] } }, request),
    (error: any) => error?.code === 'TASK_PROPOSAL_SCOPE_DENIED');
  assert.throws(() => validateTaskGoalProposal({ ...response, goal: { kind: 'semantic-workflow',
    steps: [steps[0], { kind: 'controlled-file-change', root, path: 'bad.txt', content: 'bad' }] } }, request),
    (error: any) => error?.code === 'TASK_PROPOSAL_INVALID');
  assert.throws(() => validateTaskGoalProposal({ ...response, goal: { kind: 'semantic-workflow',
    steps: [steps[0], { kind: 'browser-navigation', url: 'https://other.test/wrong' }] } }, request),
    (error: any) => error?.code === 'TASK_PROPOSAL_SCOPE_DENIED');
});

test('model may suggest a closed all-checks quality gate, never best-effort partial success', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-quality-proposal-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const request = { objective: 'lint, test and build this project', approvedRoots: [root], approvedBrowserOrigins: [] };
  const checks = ['lint', 'test', 'build'];
  const valid = { goal: { kind: 'project-quality-gate', root, checks, requireAll: true }, successConditions: ['All three registered checks succeed'] };
  assert.deepEqual(validateTaskGoalProposal(valid, request), valid);
  for (const bad of [
    { ...valid.goal, requireAll: false },
    { ...valid.goal, checks: ['test', 'test'] },
    { ...valid.goal, checks: ['test', 'shell'] },
    { ...valid.goal, checks: ['lint'] },
    { ...valid.goal, force: true }
  ]) {
    assert.throws(() => validateTaskGoalProposal({ ...valid, goal: bad }, request),
      (error: any) => error?.code === 'TASK_PROPOSAL_INVALID');
  }
});

test('local-only model adapter has fixed loopback endpoint and cannot self-execute', async () => {
  let requests = 0;
  const adapter = new LoopbackOllamaTaskGoalInterpreter({
    model: 'test-local:latest',
    fetchFn: (async (url, init) => {
      ++requests;
      assert.equal(url, 'http://127.0.0.1:11434/api/generate');
      assert.equal(init?.redirect, 'error');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.stream, false);
      assert.equal(body.options.temperature, 0);
      assert.ok(!String(init?.body).includes('api_key'));
      return new Response(JSON.stringify({ response: JSON.stringify(browser) }), { status: 200 });
    }) as typeof fetch
  });
  const value = await adapter.propose(approved);
  assert.deepEqual(validateTaskGoalProposal(value, approved), browser);
  assert.equal(requests, 1);
  assert.throws(() => new LoopbackOllamaTaskGoalInterpreter({ model: 'unsafe\nmodel' }),
    (error: any) => error?.code === 'TASK_PROPOSAL_INVALID');
});

test('model proposal deadline is enforced when fetch ignores AbortSignal', async () => {
  const adapter = new LoopbackOllamaTaskGoalInterpreter({
    model: 'test-local:latest', timeoutMs: 25,
    fetchFn: (async () => await new Promise<Response>(() => {})) as typeof fetch
  });
  await assert.rejects(() => adapter.propose(approved),
    (error: any) => error?.code === 'TASK_MODEL_TIMEOUT');
  assert.throws(() => new LoopbackOllamaTaskGoalInterpreter({ model: 'test-local:latest', timeoutMs: 12_001 }),
    (error: any) => error?.code === 'TASK_PROPOSAL_INVALID');
});

test('user cancellation rejects uncooperative model and refuses a late proposal', async () => {
  const controller = new AbortController();
  let requested!: () => void;
  let complete!: (response: Response) => void;
  const entered = new Promise<void>(resolve => { requested = resolve; });
  const neverFinishesUntilReleased = new Promise<Response>(resolve => { complete = resolve; });
  const adapter = new LoopbackOllamaTaskGoalInterpreter({
    model: 'test-local:latest', timeoutMs: 1000,
    fetchFn: (async () => { requested(); return await neverFinishesUntilReleased; }) as typeof fetch
  });
  const request = adapter.propose({ ...approved, signal: controller.signal });
  await entered;
  controller.abort();
  await assert.rejects(() => request, (error: any) => error?.code === 'TASK_MODEL_CANCELLED');
  complete(new Response(JSON.stringify({ response: JSON.stringify(browser) }), { status: 200 }));
});

test('authenticated proposal HTTP endpoint never executes; rejects missing model, runaway and foreign scopes', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-proposal-api-')));
  const other = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-proposal-other-')));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(other, { recursive: true, force: true });
  });
  const runtime = new OperatorRuntime();
  const permissions = { allowedCapabilities: ['browser.inspect', 'browser.navigate'], allowedRoots: [root],
    allowExternalWrites: false, allowDestructive: false, allowSystemChanges: false };
  const token = 'p'.repeat(64);
  const missing = createLocalAgentServer({ runtime, permissions, token });
  t.after(() => missing.close());
  const first = await missing.listen('127.0.0.1', 0);
  const auth = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const absent = await fetch('http://127.0.0.1:' + first.port + '/v1/tasks/propose',
    { method: 'POST', headers: auth, body: JSON.stringify(approved) });
  assert.equal(absent.status, 503);
  assert.equal((await absent.json() as any).error.code, 'TASK_MODEL_NOT_CONFIGURED');
  const agent = createLocalAgentServer({ runtime, permissions, token, taskGoalInterpreter: { propose: async () => browser } });
  t.after(() => agent.close());
  const second = await agent.listen('127.0.0.1', 0);
  const endpoint = 'http://127.0.0.1:' + second.port + '/v1/tasks/propose';
  const request = async (body: any) => {
    const result = await fetch(endpoint, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    return { status: result.status, body: await result.json() as any };
  };
  const ok = await request(approved);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.requiresConfirmation, true);
  assert.equal(ok.body.executionStarted, false);
  assert.deepEqual(ok.body.proposal, browser);
  const run = await request({ ...approved, run: true });
  assert.equal(run.status, 400);
  const outside = await request({ ...approved, approvedRoots: [other] });
  assert.equal(outside.status, 403);
  const unauthenticated = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(approved) });
  assert.equal(unauthenticated.status, 401);
});

test('HTTP proposal hard timeout is reported as 504 without task execution', async t => {
  const runtime = new OperatorRuntime();
  const token = 'm'.repeat(64);
  const adapter = new LoopbackOllamaTaskGoalInterpreter({
    model: 'mock-local:latest', timeoutMs: 25,
    fetchFn: (async () => await new Promise<Response>(() => {})) as typeof fetch
  });
  const server = createLocalAgentServer({
    runtime, token,
    permissions: {
      allowedCapabilities: ['browser.inspect', 'browser.navigate'], allowedRoots: [],
      allowExternalWrites: false, allowSystemChanges: false, allowDestructive: false
    },
    taskGoalInterpreter: adapter
  });
  t.after(() => server.close());
  const addr = await server.listen('127.0.0.1', 0);
  const response = await fetch('http://127.0.0.1:' + addr.port + '/v1/tasks/propose', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(approved)
  });
  assert.equal(response.status, 504);
  const body = await response.json() as any;
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'TASK_MODEL_TIMEOUT');
});

test('reviewed proposal confirmation creates exactly the proposed task without execution or replay', async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-reviewed-proposal-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const runtime = new OperatorRuntime();
  const tasks = new TaskStore(state);
  const permissions = {
    allowedRoots: [], allowedCapabilities: ['browser.navigate', 'browser.inspect'],
    allowDestructive: false, allowExternalWrites: false, allowSystemChanges: false
  };
  const taskOrchestrator = new TaskOrchestrator({ runtime, store: tasks, permissions });
  const token = 'r'.repeat(64);
  const server = createLocalAgentServer({
    token, permissions, runtime, tasks, taskOrchestrator,
    taskGoalInterpreter: { propose: async () => structuredClone(browser) }
  });
  t.after(() => server.close());
  const bound = await server.listen('127.0.0.1', 0);
  const origin = 'http://127.0.0.1:' + bound.port;
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  async function post(url: string, body: unknown) {
    const response = await fetch(origin + url, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any };
  }
  const proposed = await post('/v1/tasks/propose', approved);
  assert.equal(proposed.status, 200);
  assert.equal(proposed.data.requiresConfirmation, true);
  assert.equal(proposed.data.executionStarted, false);
  assert.equal((await tasks.list()).length, 0);
  const confirmation = {
    proposalId: proposed.data.proposalId, proposalDigest: proposed.data.proposalDigest
  };
  const altered = await post('/v1/tasks/proposals/confirm', {
    ...confirmation, goal: { kind: 'browser-navigation', url: 'https://evil.example' }, run: true
  });
  assert.equal(altered.status, 400);
  assert.equal((await tasks.list()).length, 0);
  const denied = await post('/v1/tasks/proposals/confirm', {
    ...confirmation, proposalDigest: 'f'.repeat(64)
  });
  assert.equal(denied.status, 400);
  const confirmed = await post('/v1/tasks/proposals/confirm', confirmation);
  assert.equal(confirmed.status, 202);
  assert.equal(confirmed.data.executionStarted, false);
  assert.equal(confirmed.data.task.state, 'PENDING');
  assert.equal(confirmed.data.task.id, proposed.data.proposalId);
  assert.equal(confirmed.data.task.userObjective, approved.objective);
  assert.deepEqual(confirmed.data.task.successConditions, browser.successConditions);
  assert.deepEqual(confirmed.data.task.execution.plannerState.goal, browser.goal);
  assert.equal(confirmed.data.task.execution.records.length, 0);
  const duplicate = await post('/v1/tasks/proposals/confirm', confirmation);
  assert.equal(duplicate.status, 400);
  assert.equal((await tasks.list()).length, 1);
  assert.equal((await tasks.get(proposed.data.proposalId)).state, 'PENDING');
  const anonymous = await fetch(origin + '/v1/tasks/proposals/confirm', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(confirmation)
  });
  assert.equal(anonymous.status, 401);
});
