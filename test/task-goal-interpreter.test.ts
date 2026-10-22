import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LoopbackOllamaTaskGoalInterpreter, validateTaskGoalProposal } from '../src/core/task-goal-interpreter.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
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
