import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ManagedBrowserProvider,
  ManagedChromiumLauncher,
  buildManagedBrowserArgs,
  candidateBrowserDataDirs,
  candidateBrowserPaths,
  discoverDevToolsEndpoint,
  parseDevToolsActivePort,
  type BrowserEndpointLauncher
} from '../src/capabilities/browser-managed.ts';

async function listen(t: any, handler: Parameters<typeof http.createServer>[0]): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bad address');
  return `http://127.0.0.1:${address.port}`;
}

function chromiumVersionResponse(req: http.IncomingMessage) {
  return {
    Browser: 'Chrome/Test',
    webSocketDebuggerUrl: `ws://${req.headers.host}/devtools/browser/test-browser`
  };
}

test('managed browser launch args always use an isolated non-default data directory', () => {
  const dataDir = path.resolve('/tmp/operator-browser-profile');
  const args = buildManagedBrowserArgs(dataDir);
  assert.equal(args.includes('--remote-debugging-port=0'), true);
  assert.equal(args.includes(`--user-data-dir=${dataDir}`), true);
  assert.equal(args.some((arg) => arg.includes('Default')), false);
  assert.throws(() => buildManagedBrowserArgs(path.parse(dataDir).root), /non-root absolute path/);
});

test('DevToolsActivePort parser accepts only a local browser endpoint shape', () => {
  assert.deepEqual(parseDevToolsActivePort('49152\n/devtools/browser/abc-123\n'), {
    port: 49152,
    browserPath: '/devtools/browser/abc-123',
    endpoint: 'http://127.0.0.1:49152'
  });
  assert.throws(() => parseDevToolsActivePort('70000\n/devtools/browser/abc\n'), /invalid TCP port/);
  assert.throws(() => parseDevToolsActivePort('9222\nws:\/\/evil.example\/devtools\/browser\/abc\n'), /invalid browser WebSocket path/);
});

test('Windows browser discovery includes Chrome, Chrome for Testing, and Edge without touching profile paths', () => {
  const paths = candidateBrowserPaths('win32', {
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local'
  });
  assert.equal(paths.some((item) => /Google[\\/]Chrome[\\/]Application[\\/]chrome\.exe$/i.test(item)), true);
  assert.equal(paths.some((item) => /Chrome for Testing[\\/]Application[\\/]chrome\.exe$/i.test(item)), true);
  assert.equal(paths.some((item) => /Microsoft[\\/]Edge[\\/]Application[\\/]msedge\.exe$/i.test(item)), true);
  assert.equal(paths.some((item) => /User Data|Default/i.test(item)), false);
});

test('browser data-root discovery covers Chrome and Edge channels but never enumerates individual profiles', () => {
  const dirs = candidateBrowserDataDirs('win32', {
    LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local'
  }, 'C:\\Users\\Test');
  assert.equal(dirs.some((item) => /Google\\Chrome\\User Data$/i.test(item)), true);
  assert.equal(dirs.some((item) => /Microsoft\\Edge\\User Data$/i.test(item)), true);
  assert.equal(dirs.some((item) => /Chrome Beta\\User Data$/i.test(item)), true);
  assert.equal(dirs.some((item) => /Edge Dev\\User Data$/i.test(item)), true);
  assert.equal(dirs.some((item) => /\\Default$|\\Profile \d+$/i.test(item)), false);
});

test('dynamic DevToolsActivePort discovery attaches only to a verified loopback Chromium endpoint', async (t) => {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-cdp-discovery-'));
  t.after(() => fs.rm(profileDir, { recursive: true, force: true }));
  const endpoint = await listen(t, (req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(chromiumVersionResponse(req)));
      return;
    }
    res.writeHead(404).end();
  });
  const port = Number(new URL(endpoint).port);
  await fs.writeFile(path.join(profileDir, 'DevToolsActivePort'), `${port}\n/devtools/browser/test-browser\n`);

  assert.deepEqual(await discoverDevToolsEndpoint([profileDir]), {
    endpoint,
    dataDir: path.resolve(profileDir)
  });

  const launcher = new ManagedChromiumLauncher({
    endpoint: 'http://127.0.0.1:1',
    autoLaunch: false,
    discoveryDataDirs: [profileDir]
  });
  t.after(() => launcher.close());
  assert.equal(await launcher.ensureEndpoint(), endpoint);
});

test('dynamic endpoint discovery ignores a local service that merely returns HTTP 200', async (t) => {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-cdp-fake-'));
  t.after(() => fs.rm(profileDir, { recursive: true, force: true }));
  const endpoint = await listen(t, (req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Browser: 'Not Chromium' }));
      return;
    }
    res.writeHead(404).end();
  });
  const port = Number(new URL(endpoint).port);
  await fs.writeFile(path.join(profileDir, 'DevToolsActivePort'), `${port}\n/devtools/browser/fake\n`);
  assert.equal(await discoverDevToolsEndpoint([profileDir]), undefined);
});

test('managed browser provider recovers a dead CDP endpoint through the launcher and retries once', async (t) => {
  const deadEndpoint = await listen(t, (req, res) => {
    if (req.url === '/json/list' || req.url === '/json/version') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(404).end();
  });
  const healthyEndpoint = await listen(t, (req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(chromiumVersionResponse(req)));
      return;
    }
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 'managed-1', type: 'page', title: 'Managed', url: 'about:blank' }]));
      return;
    }
    res.writeHead(404).end();
  });

  let launches = 0;
  const launcher: BrowserEndpointLauncher = {
    async ensureEndpoint() { launches += 1; return healthyEndpoint; },
    close() { /* no process in test */ }
  };
  const provider = new ManagedBrowserProvider({ endpoint: deadEndpoint, launcher });
  t.after(() => provider.close());

  const result = await provider.execute({
    id: 'managed-recovery',
    capability: 'browser.inspect',
    risk: 'read',
    input: {},
    provenance: { kind: 'chatgpt' }
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'browser.managed');
  assert.equal(launches, 1);
  assert.equal((result.output as any).tabs[0].id, 'managed-1');
  assert.equal(result.evidence.some((item) => item.kind === 'browser_lifecycle' && item.status === 'pass'), true);
});
