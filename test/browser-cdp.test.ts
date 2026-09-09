import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { BrowserCdpInspectProvider } from '../src/capabilities/browser-cdp.ts';

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
