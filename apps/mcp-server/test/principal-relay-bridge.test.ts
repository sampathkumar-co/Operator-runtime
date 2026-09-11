import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { RelayAgentClient } from '../src/relay-agent-client.ts';
import type { ActionRequest } from '../../../src/core/types.ts';

const CONTROL_TOKEN = 'relay-control-principal-0123456789abcdef';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not expose port');
  return address.port;
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}
test('verified principal is forwarded to relay without process-global account authority', async (t) => {
  const seen: Record<string, unknown>[] = [];
  const control = http.createServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/execute');
    assert.equal(req.headers.authorization, `Bearer ${CONTROL_TOKEN}`);
    const body = await readBody(req);
    seen.push(body);
    const action = body.action as ActionRequest;
    const payload = JSON.stringify({
      ok: true,
      capability: action.capability,
      provider: 'relay-principal-test',
      output: { routed: true },
      evidence: [],
      durationMs: 1
    });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  });
  const port = await listen(control);
  t.after(() => new Promise<void>((resolve) => control.close(() => resolve())));
  const client = new RelayAgentClient({
    baseUrl: `http://127.0.0.1:${port}`,
    token: CONTROL_TOKEN,
    principal: { issuer: 'https://login.operator-runtime.dev/', subject: 'user-123' },
    waitMs: 1_000
  });
  const result = await client.execute({
    id: 'action-1',
    capability: 'computer.inspect',
    risk: 'read',
    input: {},
    provenance: { kind: 'chatgpt' }
  });
  assert.equal(result.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.accountId, undefined);
  assert.deepEqual(seen[0]?.principal, {
    issuer: 'https://login.operator-runtime.dev/',
    subject: 'user-123'
  });
  assert.equal(seen[0]?.deviceId, undefined);
  assert.equal(seen[0]?.projectKey, undefined);
});
