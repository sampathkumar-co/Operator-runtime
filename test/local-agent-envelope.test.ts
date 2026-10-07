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

async function postRawJson(url: string, token: string, body: string | Blob) {
  return await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body
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

test('authenticated execution rejects excessive JSON depth and node count at the shared request boundary', async (t) => {
  const { url, token } = await withAgent(t);

  let deep: Record<string, unknown> = {};
  for (let index = 0; index < 80; index += 1) deep = { nested: deep };
  const deepResponse = await postRawJson(url, token, JSON.stringify({
    action: { ...validAction(), input: deep }
  }));
  assert.equal(deepResponse.status, 400);
  assert.equal((await deepResponse.json() as { error: { code: string } }).error.code, 'BAD_REQUEST');

  const wideResponse = await postRawJson(url, token, JSON.stringify({
    action: { ...validAction(), input: { values: Array.from({ length: 100_001 }, () => 0) } }
  }));
  assert.equal(wideResponse.status, 400);
  assert.equal((await wideResponse.json() as { error: { code: string } }).error.code, 'BAD_REQUEST');
});

test('authenticated execution rejects malformed UTF-8 before JSON parsing', async (t) => {
  const { url, token } = await withAgent(t);
  const prefix = Buffer.from('{"action":{"id":"inspect-envelope","capability":"computer.inspect","risk":"read","input":{"value":"');
  const suffix = Buffer.from('"},"provenance":{"kind":"chatgpt"}}}');
  const malformed = new Blob([prefix, new Uint8Array([0xff]), suffix], { type: 'application/json' });
  const response = await postRawJson(url, token, malformed);
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: { code: string } }).error.code, 'BAD_REQUEST');
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
