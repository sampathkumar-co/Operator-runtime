import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { RelayAgentClient } from '../src/relay-agent-client.ts';
import type { ActionRequest } from '../../../src/core/types.ts';

const CONTROL_TOKEN = 'relay-control-principal-0123456789abcdef';
const RECEIPT_DEVICE = '33333333-3333-4333-8333-333333333333';
const RECEIPT_DELIVERY = '44444444-4444-4444-8444-444444444444';

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
  const receipts: Record<string, unknown>[] = [];
  const control = http.createServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, `Bearer ${CONTROL_TOKEN}`);
    const body = await readBody(req);
    if (req.url === '/v1/execute/ack') {
      receipts.push(body);
      const payload = JSON.stringify({ ok: true });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
      return;
    }
    assert.equal(req.url, '/v1/execute');
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
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-operator-device-id': RECEIPT_DEVICE, 'x-operator-delivery-seq': '1', 'x-operator-delivery-id': RECEIPT_DELIVERY });
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
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.deviceId, RECEIPT_DEVICE);
  assert.equal(receipts[0]?.seq, 1);
  assert.equal(receipts[0]?.deliveryId, RECEIPT_DELIVERY);
});
