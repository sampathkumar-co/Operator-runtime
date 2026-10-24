import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { BrowserCdpInspectProvider } from '../src/capabilities/browser-cdp.ts';
import type { ActionRequest, PermissionProfile } from '../src/core/types.ts';

async function harness(t: test.TestContext) {
  let discoveryCount = 0;
  let unexpectedRequests = 0;
  const expectedTabs = [
    { id: 'tab-a', type: 'page', title: 'Fixture product', url: 'https://fixture.invalid/product',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/secret-browser-token' },
    { id: 'tab-b', type: 'page', title: 'Fixture cart', url: 'https://fixture.invalid/cart',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/secret-other-token' }
  ];
  const server = http.createServer((request, response) => {
    if (request.url === '/json/list') {
      discoveryCount += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(expectedTabs));
      return;
    }
    unexpectedRequests += 1;
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture address missing');
  const provider = new BrowserCdpInspectProvider(`http://127.0.0.1:${address.port}`);
  t.after(() => provider.close());
  const runtime = new OperatorRuntime().register(provider);
  const permissions: PermissionProfile = {
    allowedCapabilities: ['browser.inspect'], allowedRoots: [], maxRisk: 'read'
  };
  const action = (id: string, capability = 'browser.inspect'): ActionRequest => ({
    id, capability, risk: 'read', input: {}, provenance: { kind: 'chatgpt' }
  });
  return { runtime, permissions, action, expectedTabs,
    requests: () => ({ discoveryCount, unexpectedRequests }) };
}

test('Lane B production runtime reveals actual fixture tab state, not fabricated browser targets', async t => {
  const { runtime, permissions, action, expectedTabs, requests } = await harness(t);
  const result = await runtime.execute(action('lane-b-browser-discover'), permissions);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.provider, 'browser.cdp');
  const output = result.output as { tabs: Array<{ id: string; title: string; url: string }> };
  assert.deepEqual(output.tabs.map(tab => [tab.id, tab.title, tab.url]),
    expectedTabs.map(tab => [tab.id, tab.title, tab.url]));
  assert.equal(requests().discoveryCount, 1);
  assert.equal(requests().unexpectedRequests, 0);
});

test('Lane B does not disclose CDP debugger credentials in public inspected tab output', async t => {
  const { runtime, permissions, action } = await harness(t);
  const result = await runtime.execute(action('lane-b-cdp-redaction'), permissions);
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result.output).includes('secret-browser-token'), false);
  assert.equal(JSON.stringify(result.output).includes('webSocketDebuggerUrl'), false);
});

test('Lane B denies unapproved browser write capability before any CDP request', async t => {
  const { runtime, permissions, action, requests } = await harness(t);
  const attempted = { ...action('lane-b-browser-denied', 'browser.navigate'),
    risk: 'write' as const, input: { url: 'https://fixture.invalid/checkout' } };
  const result = await runtime.execute(attempted, permissions);
  assert.equal(result.ok, false);
  assert.equal(result.provider, 'policy');
  assert.equal(result.error?.code, 'CAPABILITY_DENIED');
  assert.deepEqual(requests(), { discoveryCount: 0, unexpectedRequests: 0 });
});

test('Lane B aborts before observing a browser if cancellation was already requested', async t => {
  const { runtime, permissions, action, requests } = await harness(t);
  const controller = new AbortController();
  controller.abort();
  const result = await runtime.execute(action('lane-b-browser-cancel'), permissions, {
    signal: controller.signal
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'EXECUTION_ABORTED');
  assert.deepEqual(requests(), { discoveryCount: 0, unexpectedRequests: 0 });
});
