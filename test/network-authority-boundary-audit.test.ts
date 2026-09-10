import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { LocalAgentClient, validateLoopbackAgentUrl } from '../apps/mcp-server/src/local-agent-client.ts';

async function listen(t: test.TestContext, handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server address unavailable');
  return `http://127.0.0.1:${address.port}`;
}

test('direct local-agent URL is credential-free loopback HTTP only', () => {
  assert.equal(validateLoopbackAgentUrl('http://127.0.0.1:47100').toString(), 'http://127.0.0.1:47100/v1/execute');
  assert.equal(validateLoopbackAgentUrl('http://[::1]:47100').hostname, '[::1]');
  for (const unsafe of [
    'https://127.0.0.1:47100',
    'http://example.com:47100',
    'http://user:pass@127.0.0.1:47100',
    'http://127.0.0.1:47100/?target=elsewhere',
    'http://127.0.0.1:47100/#fragment'
  ]) assert.throws(() => validateLoopbackAgentUrl(unsafe));
});

test('authenticated local-agent fetch refuses redirects before forwarding the request', async (t) => {
  let targetHits = 0;
  const target = await listen(t, (_req, res) => {
    targetHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, provider: 'unexpected', evidence: [] }));
  });
  const redirector = await listen(t, (_req, res) => {
    res.writeHead(307, { location: `${target}/stolen` });
    res.end();
  });
  const previousMode = process.env.OPERATOR_EXECUTION_MODE;
  process.env.OPERATOR_EXECUTION_MODE = 'local';
  t.after(() => {
    if (previousMode === undefined) delete process.env.OPERATOR_EXECUTION_MODE;
    else process.env.OPERATOR_EXECUTION_MODE = previousMode;
  });
  const client = new LocalAgentClient(redirector, 'x'.repeat(32));
  await assert.rejects(() => client.execute({
    id: 'redirect-test', capability: 'system.inspect', risk: 'read', input: {}, provenance: { kind: 'chatgpt' }
  }));
  assert.equal(targetHits, 0);
});

test('network authority fetches remain redirect-disabled', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const cases = [
    ['apps/mcp-server/src/local-agent-client.ts', 1],
    ['apps/mcp-server/src/relay-agent-client.ts', 1],
    ['apps/local-agent/src/relay-agent.ts', 2],
    ['src/capabilities/browser-cdp.ts', 5],
    ['src/capabilities/browser-managed.ts', 1]
  ] as const;
  for (const [relative, expected] of cases) {
    const source = await fs.readFile(path.join(root, relative), 'utf8');
    const count = source.split("redirect: 'error'").length - 1;
    assert.equal(count, expected, `${relative} must reject redirects at every network boundary`);
  }
});