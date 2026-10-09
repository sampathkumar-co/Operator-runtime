import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { boundBrowserInspectOutput, BrowserCdpInspectProvider } from '../src/capabilities/browser-cdp.ts';

test('aborted browser execution fails before contacting CDP', async () => {
  const provider = new BrowserCdpInspectProvider('http://127.0.0.1:65534');
  const controller = new AbortController();
  controller.abort();
  const result = await provider.execute({
    id: 'browser-abort',
    capability: 'browser.inspect',
    risk: 'read',
    input: {},
    provenance: { kind: 'chatgpt' }
  }, { signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'EXECUTION_ABORTED');
  provider.close();
});

test('browser inspect returns compact semantic tab state from CDP discovery endpoint', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: '1', type: 'page', title: 'GitHub', url: 'https://github.com/example/repo', webSocketDebuggerUrl: 'ws://secret' }]));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bad address');

  const provider = new BrowserCdpInspectProvider(`http://127.0.0.1:${address.port}`);
  const result = await provider.execute({ id: 'b1', capability: 'browser.inspect', risk: 'read', input: {}, provenance: { kind: 'chatgpt' } });
  assert.equal(result.ok, true);
  const tabs = (result.output as { tabs: Array<Record<string, unknown>> }).tabs;
  assert.deepEqual(tabs[0], { id: '1', type: 'page', title: 'GitHub', url: 'https://github.com/example/repo' });
  assert.equal('webSocketDebuggerUrl' in tabs[0], false);
});


test('browser inspect output is serialized-byte bounded before relay delivery', () => {
  const controls = Array.from({ length: 160 }, (_, index) => ({ name: `Control ${index} ${'x'.repeat(300)}`, selector: `#control-${index}`, actionable: true }));
  const visibleText = Array.from({ length: 200 }, (_, index) => ({ text: `Text ${index} ${'y'.repeat(300)}`, selector: `#text-${index}` }));
  const visualObjects = Array.from({ length: 120 }, (_, index) => ({ name: `Visual ${index}`, selector: `#visual-${index}`, colors: { background: 'rgb(1, 2, 3)' }, actionable: true }));
  const output: any = {
    target: { id: 'tab-1', title: 'Large page', url: 'https://example.test/' },
    page: {
      accessibility: Array.from({ length: 160 }, (_, index) => ({ role: 'button', name: `AX ${index} ${'z'.repeat(200)}` })),
      semantic: {
        controls, visibleText, visualObjects, visuals: visualObjects,
        headings: Array.from({ length: 60 }, (_, index) => `Heading ${index}`),
        forms: Array.from({ length: 30 }, (_, index) => ({ name: `Form ${index}`, fields: Array(20).fill('field') })),
        pagination: {
          controls: { offset: 0, returned: controls.length, total: controls.length, truncated: false },
          visibleText: { offset: 0, returned: visibleText.length, total: visibleText.length, truncated: false },
          visualObjects: { offset: 0, returned: visualObjects.length, total: visualObjects.length, truncated: false }
        }
      },
      frames: [],
      frameCoverage: { status: 'complete' }
    }
  };
  const bounded = boundBrowserInspectOutput(output, 16 * 1024);
  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.output), 'utf8') <= 16 * 1024);
  assert.ok(bounded.returnedBytes <= 16 * 1024);
  assert.equal((bounded.output.page as any).semantic.pagination.controls.truncated, true);
});

test('CDP target discovery rejects oversized chunked responses before JSON parsing', async (t) => {
  const oversized = '[' + ' '.repeat(1024 * 1024 + 256) + ']';
  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(oversized);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bad address');
  const provider = new BrowserCdpInspectProvider(`http://127.0.0.1:${address.port}`);
  t.after(() => provider.close());
  const result = await provider.execute({
    id: 'oversized-discovery', capability: 'browser.inspect', risk: 'read',
    input: {}, provenance: { kind: 'chatgpt' }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'CDP_DISCOVERY_TOO_LARGE');
});

test('CDP discovery rejects invalid target-list JSON structure', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'not-an-array' }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bad address');
  const provider = new BrowserCdpInspectProvider(`http://127.0.0.1:${address.port}`);
  t.after(() => provider.close());
  const result = await provider.execute({
    id: 'malformed-discovery', capability: 'browser.inspect', risk: 'read',
    input: {}, provenance: { kind: 'chatgpt' }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'CDP_DISCOVERY_INVALID');
});
