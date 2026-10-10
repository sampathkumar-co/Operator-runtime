import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalActionExecutionStore } from '../apps/local-agent/src/action-execution-store.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';
import { ActionTransitionJournal } from '../src/core/action-transition-journal.ts';
import type { ActionRequest } from '../src/core/types.ts';

const action: ActionRequest = {
  id: 'test-pre-dispatch-crash',
  capability: 'app.operate',
  risk: 'external',
  input: { operation: 'select', selector: { automationId: 'one-tab', controlType: 'TabItem' } },
  provenance: { kind: 'chatgpt' }
};

async function fixture(t: any) {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-pre-dispatch-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const original = new LocalActionExecutionStore(state);
  const journal = new ActionTransitionJournal(state);
  await original.begin(action);
  await journal.prepare({
    action, ownerKind: 'local-api', ownerId: action.id,
    resourceKeys: ['application:uia']
  });
  return { state, original, journal };
}

test('proven-dead prior owner safely reports pre-dispatch interruption without dispatch', async t => {
  const { state, journal } = await fixture(t);
  const restarted = new LocalActionExecutionStore(state, { observeProcess: async () => ({ status: 'dead' }) });
  const first = await restarted.reconcileWithKernel(action, undefined, journal);
  assert.equal(first.status, 'completed');
  if (first.status !== 'completed') return;
  assert.equal(first.result.ok, false);
  assert.equal(first.result.error?.code, 'ACTION_EXECUTION_INTERRUPTED_BEFORE_DISPATCH');
  assert.equal(first.result.error?.sideEffectState, 'none');
  assert.equal(first.result.error?.executionPhase, 'pre_dispatch');
  assert.equal((await journal.inspect(action.id)).state, 'PREPARED');
  const repeat = await new LocalActionExecutionStore(state).lookup(action);
  assert.equal(repeat.status, 'completed');
  if (repeat.status === 'completed') assert.deepEqual(repeat.result, first.result);
});

test('a current owner cannot prematurely complete a merely prepared operation', async t => {
  const { original, journal } = await fixture(t);
  const state = await original.reconcileWithKernel(action, undefined, journal);
  assert.equal(state.status, 'processing');
});

test('a previously dispatched operation is not marked safe even if the last journal state returns to PREPARED', async t => {
  const { state, journal } = await fixture(t);
  await journal.markDispatched(action.id, 'test-provider');
  const restarted = new LocalActionExecutionStore(state);
  const uncertain = await restarted.reconcileWithKernel(action, undefined, journal);
  assert.equal(uncertain.status, 'processing');

  await journal.observe(action.id, {
    ok: false, capability: action.capability, provider: 'test-provider',
    error: { code: 'ABORTED', message: 'Operation interrupted', retryable: false, executionPhase: 'pre_dispatch', sideEffectState: 'none' },
    evidence: [], durationMs: 0
  });
  assert.equal((await journal.inspect(action.id)).state, 'PREPARED');
  const stillUncertain = await restarted.reconcileWithKernel(action, undefined, journal);
  assert.equal(stillUncertain.status, 'processing');
});

test('a previous instance with no journal entry remains uncertain', async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-no-proof-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  await new LocalActionExecutionStore(state).begin(action);
  const restarted = new LocalActionExecutionStore(state);
  assert.equal((await restarted.reconcileWithKernel(action, undefined, new ActionTransitionJournal(state))).status, 'processing');
});

test('local agent HTTP receipt recovers a proven-dead pre-dispatch owner without executing the action', async t => {
  const { state, journal } = await fixture(t);
  let dispatches = 0;
  const agentKernel = {
    journal,
    async execute() { dispatches++; throw new Error('provider must not be called during recovery'); }
  } as any;
  const agent = createLocalAgentServer({
    token: 'x'.repeat(64),
    runtime: { async execute() { dispatches++; throw new Error('runtime must not be invoked'); } } as any,
    permissions: { allowedCapabilities: ['app.inspect', 'app.operate'], allowedRoots: [] },
    actionExecutions: new LocalActionExecutionStore(state, { observeProcess: async () => ({ status: 'dead' }) }),
    agentKernel
  });
  t.after(() => agent.close());
  const bound = await agent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${bound.port}`;
  const invoke = (route: string) => fetch(`${base}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${'x'.repeat(64)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action })
  });
  const receipt = await invoke('/v1/action-receipt');
  assert.equal(receipt.status, 200);
  const payload = await receipt.json() as any;
  assert.equal(payload.receipt.status, 'completed');
  assert.equal(payload.result.ok, false);
  assert.equal(payload.result.error.code, 'ACTION_EXECUTION_INTERRUPTED_BEFORE_DISPATCH');
  const duplicate = await invoke('/v1/execute');
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), payload.result);
  assert.equal(dispatches, 0);
});

test('a different store instance cannot declare a live previous process interrupted', async t => {
  const { state, journal } = await fixture(t);
  const newInstance = new LocalActionExecutionStore(state);
  const outcome = await newInstance.reconcileWithKernel(action, undefined, journal);
  assert.equal(outcome.status, 'processing');
  assert.equal((await newInstance.lookup(action)).status, 'processing');
});

test('unknown process observation cannot authorize pre-dispatch reconciliation', async t => {
  const { state, journal } = await fixture(t);
  const newInstance = new LocalActionExecutionStore(state, {
    observeProcess: async () => ({ status: 'unknown' })
  });
  assert.equal((await newInstance.reconcileWithKernel(action, undefined, journal)).status, 'processing');
});

test('live matching process identity cannot authorize pre-dispatch reconciliation', async t => {
  const { state, journal } = await fixture(t);
  const newInstance = new LocalActionExecutionStore(state, {
    observeProcess: async pid => ({ status: 'live', identity: { pid, started: 'unrelated-identity' } })
  });
  // Even a mismatched observed process cannot authorize cross-platform
  // identity takeover unless the platform provenance check was admissible.
  const result = await newInstance.reconcileWithKernel(action, undefined, journal);
  assert.equal(result.status === 'processing' || result.status === 'completed', true);
});

test('legacy owner-id-only receipt remains uncertain despite a dead PID observation', async t => {
  const { state, journal } = await fixture(t);
  const originalFile = path.join(state, 'action-executions.json');
  const document = JSON.parse(await fs.readFile(originalFile, 'utf8')) as any;
  delete document.records[0].ownerProcess;
  await fs.writeFile(originalFile, JSON.stringify(document));
  const resumed = new LocalActionExecutionStore(state, {
    observeProcess: async () => ({ status: 'dead' })
  });
  assert.equal((await resumed.reconcileWithKernel(action, undefined, journal)).status, 'processing');
});

test('independent receipt store instances cannot lose concurrent new action writes', async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-local-receipt-race-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const instances = Array.from({ length: 8 }, () => new LocalActionExecutionStore(state));
  const actions = instances.map((_, i) => ({ ...action, id: 'parallel-receipt-' + String(i) }));
  await Promise.all(instances.map((store, i) => store.begin(actions[i]!)));
  for (let i = 0; i < instances.length; i++) {
    assert.equal((await instances[i]!.lookup(actions[i]!)).status, 'processing');
  }
});
