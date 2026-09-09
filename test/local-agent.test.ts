import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

test('local agent requires bearer token and returns structured evidence', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-agent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const token = 'a'.repeat(64);
  const runtime = createRuntime({ allowedRoots: [root], allowedExecutables: ['node'] });
  const agent = createLocalAgentServer({
    runtime,
    token,
    permissions: { allowedCapabilities: ['computer.inspect', 'file.*'], allowedRoots: [root] }
  });
  t.after(() => agent.close());
  const bound = await agent.listen('127.0.0.1', 0);
  const url = `http://127.0.0.1:${bound.port}/v1/execute`;

  const denied = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 401);

  const allowed = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: { id: 'inspect-1', capability: 'computer.inspect', risk: 'read', input: {}, provenance: { kind: 'chatgpt' } } })
  });
  assert.equal(allowed.status, 200);
  const body = await allowed.json() as { ok: boolean; evidence: unknown[] };
  assert.equal(body.ok, true);
  assert.ok(body.evidence.length >= 1);
});
