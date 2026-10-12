import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';
import { LocalActionExecutionStore } from '../apps/local-agent/src/action-execution-store.ts';
import { OperatorError } from '../src/core/errors.ts';
import type { OperatorRuntime } from '../src/core/runtime.ts';

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-relay-read-recovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('pre-dispatch read error completes its local execution receipt for relay acknowledgement', async (t) => {
  const root = await temp(t);
  const state = await temp(t);
  const receipts = new LocalActionExecutionStore(state);
  const token = 'a'.repeat(64);
  let dispatched = 0;
  const runtime = {
    execute: async () => {
      dispatched += 1;
      throw new OperatorError('RESOURCE_TARGET_REQUIRED', 'Capability docker.inspect did not resolve to a concrete resource identity.');
    }
  } as unknown as OperatorRuntime;
  const agent = createLocalAgentServer({
    runtime,
    token,
    permissions: { allowedCapabilities: ['docker.inspect'], allowedRoots: [root] },
    actionExecutions: receipts
  });
  t.after(() => agent.close());
  const bound = await agent.listen();
  const action = {
    id: 'test-pathless-docker-inspect',
    capability: 'docker.inspect',
    risk: 'read',
    input: {},
    provenance: { kind: 'chatgpt' }
  };
  const request = (route: string) => fetch(`http://127.0.0.1:${bound.port}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action })
  });

  const response = await request('/v1/execute');
  assert.equal(response.status, 409);
  const body = await response.json() as any;
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'RESOURCE_TARGET_REQUIRED');
  assert.equal(body.error.sideEffectState, 'none');
  assert.equal(dispatched, 1);

  const receipt = await request('/v1/action-receipt');
  assert.equal(receipt.status, 200);
  const recorded = await receipt.json() as any;
  assert.equal(recorded.receipt.status, 'completed');
  assert.equal(recorded.result.error.code, 'RESOURCE_TARGET_REQUIRED');
  assert.equal((await receipts.lookup(action as any)).status, 'completed');
});

test('thrown mutation does not get a fabricated completion receipt or duplicate execution', async (t) => {
  const root = await temp(t);
  const state = await temp(t);
  const token = 'b'.repeat(64);
  let executions = 0;
  const runtime = {
    execute: async () => {
      executions += 1;
      throw new OperatorError('WRITE_OUTCOME_UNKNOWN', 'Mutation outcome cannot be proven.', { retryable: false });
    }
  } as unknown as OperatorRuntime;
  const store = new LocalActionExecutionStore(state);
  const agent = createLocalAgentServer({
    runtime,
    token,
    permissions: { allowedCapabilities: ['file.write'], allowedRoots: [root] },
    actionExecutions: store
  });
  t.after(() => agent.close());
  const bound = await agent.listen();
  const action = {
    id: 'test-uncertain-mutation',
    capability: 'file.write',
    risk: 'write',
    input: { path: path.join(root, 'output.txt'), content: 'test' },
    provenance: { kind: 'chatgpt' }
  };
  const request = () => fetch(`http://127.0.0.1:${bound.port}/v1/execute`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action })
  });

  const first = await request();
  assert.equal(first.status, 400);
  assert.equal((await store.lookup(action as any)).status, 'processing');
  const second = await request();
  assert.equal(second.status, 409);
  const body = await second.json() as any;
  assert.equal(body.error.code, 'ACTION_EXECUTION_IN_PROGRESS');
  assert.equal(executions, 1, 'write is never replayed without reconciliation');
});

test('caller-mislabeled write cannot be treated as side-effect-free read failure', async (t) => {
  const root = await temp(t);
  const state = await temp(t);
  const token = 'c'.repeat(64);
  let executions = 0;
  const runtime = {
    execute: async () => {
      executions += 1;
      throw new OperatorError('ACTION_RISK_MISMATCH', 'Write capability was falsely labeled read.');
    }
  } as unknown as OperatorRuntime;
  const store = new LocalActionExecutionStore(state);
  const agent = createLocalAgentServer({
    runtime, token,
    permissions: { allowedCapabilities: ['file.write'], allowedRoots: [root] },
    actionExecutions: store
  });
  t.after(() => agent.close());
  const bound = await agent.listen();
  const action = {
    id: 'misclassified-write',
    capability: 'file.write',
    risk: 'read',
    input: { path: path.join(root, 'blocked.txt'), content: 'never-write' },
    provenance: { kind: 'chatgpt' }
  };
  const req = () => fetch(`http://127.0.0.1:${bound.port}/v1/execute`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action })
  });
  const first = await req();
  assert.equal(first.status, 400);
  const record = await store.lookup(action as any);
  assert.equal(record.status, 'processing', 'untrusted risk cannot finalize a potential mutation');
  const duplicate = await req();
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json() as any).error.code, 'ACTION_EXECUTION_IN_PROGRESS');
  assert.equal(executions, 1);
});

test('post-dispatch read completion failure is durably finalized rather than stranded', async (t) => {
  const root = await temp(t);
  const state = await temp(t);
  const token = 'd'.repeat(64);
  let hits = 0;
  const runtime = {
    execute: async () => {
      hits += 1;
      return {
        ok: true, capability: 'file.read', provider: 'filesystem.native',
        output: { content: 'read-only-result' }, evidence: [], durationMs: 1
      };
    }
  } as unknown as OperatorRuntime;
  const store = new LocalActionExecutionStore(state);
  const agent = createLocalAgentServer({
    runtime, token, actionExecutions: store,
    permissions: { allowedCapabilities: ['file.read'], allowedRoots: [root] },
    beforeActionReceiptCompletion: () => { throw new OperatorError('READ_COMPLETION_HOOK_FAILED', 'Injected read completion failure'); }
  });
  t.after(() => agent.close());
  const address = await agent.listen();
  const action = {
    id: 'read-postdispatch-failure', capability: 'file.read',
    risk: 'read', input: { path: path.join(root, 'read.txt') },
    provenance: { kind: 'chatgpt' }
  };
  const request = (endpoint: string) => fetch(`http://127.0.0.1:${address.port}${endpoint}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action })
  });
  const response = await request('/v1/execute');
  assert.equal(response.status, 409);
  const failed = await response.json() as any;
  assert.equal(failed.error.code, 'READ_COMPLETION_HOOK_FAILED');
  assert.equal(failed.error.sideEffectState, 'none');
  const receipt = await request('/v1/action-receipt');
  assert.equal(receipt.status, 200);
  const persisted = await receipt.json() as any;
  assert.equal(persisted.receipt.status, 'completed');
  assert.equal(persisted.result.error.code, 'READ_COMPLETION_HOOK_FAILED');
  assert.equal(hits, 1);
});
