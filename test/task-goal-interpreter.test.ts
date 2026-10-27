import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LoopbackOllamaTaskGoalInterpreter, validateTaskGoalProposal } from '../src/core/task-goal-interpreter.ts';

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



test('C05 untrusted model proposal getter and coercible project command never execute', () => {
  let invoked = 0;
  const withGetter = Object.defineProperty({}, 'goal', {
    enumerable: true, get() { invoked += 1; throw new Error('must never run'); }
  });
  assert.throws(() => validateTaskGoalProposal(withGetter, approved),
    (e: any) => e?.code === 'TASK_PROPOSAL_INVALID');
  const root = path.resolve('approved-project');
  const goal = {
    goal: { kind: 'trusted-project-command', root,
      commandKind: { toString() { invoked += 1; return 'test'; } } },
    successConditions: ['test exit observed']
  };
  assert.throws(() => validateTaskGoalProposal(goal, {
    objective: 'Run trusted tests', approvedRoots: [root], approvedBrowserOrigins: []
  }), (e: any) => e?.code === 'TASK_PROPOSAL_INVALID');
  assert.equal(invoked, 0);
});

test('C05 proposal rejects inferred descendant roots and executable scope arrays', () => {
  const root = path.resolve('approved-project');
  const child = path.join(root, 'new-subproject');
  assert.throws(() => validateTaskGoalProposal({
    goal: { kind: 'trusted-project-command', root: child, commandKind: 'test' },
    successConditions: ['exit observed']
  }, { objective: 'Run test', approvedRoots: [root], approvedBrowserOrigins: [] }),
  (e: any) => e?.code === 'TASK_PROPOSAL_SCOPE_DENIED');
  let invoked = 0;
  const scope = Object.defineProperty([root], '0', {
    enumerable: true, configurable: true,
    get() { invoked += 1; throw Error('must never access'); }
  });
  assert.throws(() => validateTaskGoalProposal({
    goal: { kind: 'trusted-project-command', root, commandKind: 'test' },
    successConditions: ['exit observed']
  }, { objective: 'Run test', approvedRoots: scope, approvedBrowserOrigins: [] }),
  (e: any) => e?.code === 'TASK_PROPOSAL_INVALID');
  assert.equal(invoked, 0);
});

test('C05 model proposal requires dense inert checks, steps and observable conditions', () => {
  const aliased = structuredClone(browser);
  Object.defineProperty(aliased.successConditions, '0', {
    enumerable: true, configurable: true,
    get() { throw new Error('must never read'); }
  });
  assert.throws(() => validateTaskGoalProposal(aliased, approved),
    (e: any) => e?.code === 'TASK_PROPOSAL_INVALID');
  const suspicious = {
    goal: { kind: 'semantic-workflow', steps: [
      { kind: 'browser-navigation', url: 'https://example.test/1' },
      { kind: 'browser-navigation', url: 'https://example.test/2' }
    ] },
    successConditions: ['each visited']
  };
  Object.defineProperty(suspicious.goal.steps, '1', {
    enumerable: true, configurable: true,
    get() { throw Error('must never read'); }
  });
  assert.throws(() => validateTaskGoalProposal(suspicious, approved),
    (e: any) => e?.code === 'TASK_PROPOSAL_INVALID');
});
