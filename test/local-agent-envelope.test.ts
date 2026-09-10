import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

async function withAgent(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-envelope-'));
  const token = 'e'.repeat(64);
  const runtime = createRuntime({ allowedRoots: [root], allowedExecutables: [] });
  const agent = createLocalAgentServer({
    runtime,
    token,
    permissions: { allowedCapabilities: ['computer.inspect'], allowedRoots: [root] }
  });
  const bound = await agent.listen('127.0.0.1', 0);
  t.after(async () => {
    await Promise.allSettled([agent.close(), runtime.close()]);
    await fs.rm(root, { recursive: true, force: true });
  });
  return { url: `http://127.0.0.1:${bound.port}/v1/execute`, token, agent };
}

function validAction() {
  return { id: 'inspect-envelope', capability: 'computer.inspect', risk: 'read', input: {}, provenance: { kind: 'chatgpt' } };
}

async function post(url: string, token: string, action: unknown) {
  return await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action })
  });
}

test('authenticated execution rejects malformed action envelopes before runtime policy', async (t) => {
  const { url, token } = await withAgent(t);

  const cases: Array<[string, unknown]> = [
    ['invalid risk', { ...validAction(), risk: 'totally-safe' }],
    ['missing provenance', { ...validAction(), provenance: undefined }],
    ['invalid provenance kind', { ...validAction(), provenance: { kind: 'remote-webpage-admin' } }],
    ['array input', { ...validAction(), input: [] }],
    ['invalid capability characters', { ...validAction(), capability: 'computer.inspect\nother' }],
    ['empty action id', { ...validAction(), id: '' }],
    ['NUL metadata', { ...validAction(), target: 'safe\0unsafe' }]
  ];

  for (const [label, action] of cases) {
    const response = await post(url, token, action);
    assert.equal(response.status, 400, label);
    const body = await response.json() as { ok: boolean; error: { code: string } };
    assert.equal(body.ok, false, label);
    assert.equal(body.error.code, 'BAD_REQUEST', label);
  }
});

test('authenticated execution still accepts bounded human-readable action identifiers', async (t) => {
  const { url, token } = await withAgent(t);
  const response = await post(url, token, validAction());
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { ok: boolean }).ok, true);
});

test('local-agent HTTP server has bounded receive and keep-alive defaults', async (t) => {
  const { agent } = await withAgent(t);
  assert.equal(agent.server.headersTimeout, 10_000);
  assert.equal(agent.server.requestTimeout, 30_000);
  assert.equal(agent.server.keepAliveTimeout, 5_000);
  assert.equal(agent.server.maxRequestsPerSocket, 100);
});
