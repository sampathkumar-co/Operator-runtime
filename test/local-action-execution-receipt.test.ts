import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';
import { LocalActionExecutionStore } from '../apps/local-agent/src/action-execution-store.ts';
import { ActionTransitionJournal } from '../src/core/action-transition-journal.ts';

const token = 'x'.repeat(64);
const action = {
  id: 'receipt-http-action',
  capability: 'file.create',
  risk: 'write' as const,
  input: { path: 'receipt-http.txt', content: 'once' },
  provenance: { kind: 'chatgpt' as const }
};

function runtime(counter: { hits: number }) {
  return {
    async execute(request: any) {
      counter.hits += 1;
      return {
        ok: true,
        capability: request.capability,
        provider: 'test.runtime',
        output: { execution: counter.hits },
        evidence: [],
        durationMs: 1
      };
    }
  } as any;
}

async function post(base: string, pathName: string, body: unknown) {
  return await fetch(`${base}${pathName}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

test('local execute persists completed receipt before response and exact duplicate does not execute twice', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-local-action-receipt-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const counter = { hits: 0 };
  const receipts = new LocalActionExecutionStore(state);
  const agent = createLocalAgentServer({
    runtime: runtime(counter),
    token,
    permissions: { allowedCapabilities: ['file.*'], allowedRoots: [state] },
    actionExecutions: receipts
  });
  t.after(() => agent.close());
  const bound = await agent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${bound.port}`;

  const first = await post(base, '/v1/execute', { action });
  assert.equal(first.status, 200);
  const firstBody = await first.json() as any;
  assert.equal(counter.hits, 1);

  const duplicate = await post(base, '/v1/execute', { action });
  assert.equal(duplicate.status, 200);
  const duplicateBody = await duplicate.json() as any;
  assert.equal(counter.hits, 1, 'exact duplicate must replay the durable receipt rather than execute');
  assert.deepEqual(duplicateBody, firstBody);

  const receipt = await post(base, '/v1/action-receipt', { action });
  assert.equal(receipt.status, 200);
  const receiptBody = await receipt.json() as any;
  assert.equal(receiptBody.receipt.status, 'completed');
  assert.deepEqual(receiptBody.result, firstBody);
});

test('unfinished durable receipt blocks duplicate mutation and reports processing state after server restart', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-local-action-processing-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const firstStore = new LocalActionExecutionStore(state);
  await firstStore.begin({ ...action, id: 'processing-http-action' });

  const counter = { hits: 0 };
  const agent = createLocalAgentServer({
    runtime: runtime(counter),
    token,
    permissions: { allowedCapabilities: ['file.*'], allowedRoots: [state] },
    actionExecutions: new LocalActionExecutionStore(state)
  });
  t.after(() => agent.close());
  const bound = await agent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${bound.port}`;
  const processingAction = { ...action, id: 'processing-http-action' };

  const duplicate = await post(base, '/v1/execute', { action: processingAction });
  assert.equal(duplicate.status, 409);
  const body = await duplicate.json() as any;
  assert.equal(body.error.code, 'ACTION_EXECUTION_IN_PROGRESS');
  assert.equal(body.error.sideEffectState, 'uncertain');
  assert.equal(counter.hits, 0);

  const receipt = await post(base, '/v1/action-receipt', { action: processingAction });
  assert.equal(receipt.status, 202);
  assert.equal((await receipt.json() as any).receipt.status, 'processing');
});

test('restart repairs crash after kernel completion without replaying the provider mutation', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-local-action-kernel-repair-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const journal = new ActionTransitionJournal(state);
  const counter = { hits: 0 };
  const kernelResult = {
    ok: true,
    capability: action.capability,
    provider: 'test.runtime',
    output: { execution: 1 },
    evidence: [],
    durationMs: 1
  };
  const agentKernel = {
    journal,
    async execute(request: typeof action) {
      counter.hits += 1;
      await journal.prepare({ action: request, ownerKind: 'local-api', ownerId: request.id, resourceKeys: ['path:receipt-http.txt'] });
      await journal.markDispatched(request.id, kernelResult.provider);
      await journal.observe(request.id, kernelResult);
      await journal.complete(request.id, 'b'.repeat(64), kernelResult);
      return kernelResult;
    }
  } as any;
  let faulted = false;
  const first = createLocalAgentServer({
    runtime: runtime({ hits: 0 }), agentKernel, token,
    permissions: { allowedCapabilities: ['file.*'], allowedRoots: [state] },
    actionExecutions: new LocalActionExecutionStore(state),
    beforeActionReceiptCompletion: () => {
      if (!faulted) {
        faulted = true;
        throw new Error('fault after kernel completion before receipt completion');
      }
    }
  });
  const firstBound = await first.listen('127.0.0.1', 0);
  const firstResponse = await post(`http://127.0.0.1:${firstBound.port}`, '/v1/execute', { action });
  assert.equal(firstResponse.status, 400);
  assert.equal(counter.hits, 1);
  assert.equal((await new LocalActionExecutionStore(state).lookup(action)).status, 'processing');
  assert.equal((await journal.inspect(action.id)).state, 'COMPLETED');
  await first.close();

  const restartedKernel = {
    journal,
    async execute() {
      counter.hits += 1;
      throw new Error('provider mutation must not replay during receipt repair');
    }
  } as any;
  const restarted = createLocalAgentServer({
    runtime: runtime({ hits: 0 }), agentKernel: restartedKernel, token,
    permissions: { allowedCapabilities: ['file.*'], allowedRoots: [state] },
    actionExecutions: new LocalActionExecutionStore(state)
  });
  t.after(() => restarted.close());
  const restartedBound = await restarted.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${restartedBound.port}`;

  const repaired = await post(base, '/v1/action-receipt', { action });
  assert.equal(repaired.status, 200);
  assert.deepEqual((await repaired.json() as any).result, kernelResult);
  assert.equal(counter.hits, 1);

  const duplicate = await post(base, '/v1/execute', { action });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), kernelResult);
  assert.equal(counter.hits, 1);

  const repairedAgain = await post(base, '/v1/action-receipt', { action });
  assert.equal(repairedAgain.status, 200);
  assert.deepEqual((await repairedAgain.json() as any).result, kernelResult);
  assert.equal(counter.hits, 1);
});
