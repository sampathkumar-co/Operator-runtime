import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalAgentClient, validateLoopbackAgentUrl } from '../apps/mcp-server/src/local-agent-client.ts';
import { LocalAgentRelayRunner } from '../apps/local-agent/src/relay-agent.ts';
import { CdpConnection, assertLoopbackDebuggerUrl } from '../src/capabilities/browser-cdp-connection.ts';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { RelayClient, type RelaySocketLike } from '../src/core/relay-client.ts';
import { applyBoundedHttpServerPolicy, requireLiteralLoopbackBindHost } from '../src/core/network-authority.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';

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

test('CDP WebSocket URLs reject embedded credentials and fragments', () => {
  assert.doesNotThrow(() => assertLoopbackDebuggerUrl('ws://127.0.0.1:9222/devtools/page/1'));
  assert.throws(() => assertLoopbackDebuggerUrl('ws://user:pass@127.0.0.1:9222/devtools/page/1'));
  assert.throws(() => assertLoopbackDebuggerUrl('ws://127.0.0.1:9222/devtools/page/1#hidden'));
});

class MismatchedRelaySocket implements RelaySocketLike {
  readyState = 0;
  readonly url = 'ws://127.0.0.1:9998/relay';
  sent: string[] = [];
  #listeners = new Map<string, Set<(event: any) => void>>();
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void {
    let set = this.#listeners.get(type);
    if (!set) { set = new Set(); this.#listeners.set(type, set); }
    set.add(listener);
  }
  removeEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }
  open(): void { this.readyState = 1; for (const listener of this.#listeners.get('open') ?? []) listener({}); }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
}

test('relay refuses a changed opened WebSocket destination before sending the session token', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-relay-destination-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const socket = new MismatchedRelaySocket();
  const identity = new DeviceIdentityStore(stateDir, { platform: 'linux' });
  const client = new RelayClient({
    stateDir,
    url: 'ws://127.0.0.1:9999/relay',
    allowLoopbackInsecureWs: true,
    identity,
    socketFactory: () => { queueMicrotask(() => socket.open()); return socket; },
    getSessionToken: async () => 'session-token-that-must-not-leave',
    onDelivery: async () => {},
    sleep: async () => {}
  });
  await assert.rejects(client.run(), (error: any) => error?.code === 'RELAY_SOCKET_DESTINATION_CHANGED');
  assert.deepEqual(socket.sent, []);
});

test('CDP refuses a changed opened WebSocket destination before sending commands', async (t) => {
  const OriginalWebSocket = globalThis.WebSocket;
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 0;
    url = 'ws://127.0.0.1:9333/devtools/page/other';
    sent: string[] = [];
    #listeners = new Map<string, Set<(event: any) => void>>();
    constructor(_url: string) { queueMicrotask(() => { this.readyState = 1; this.#emit('open', {}); }); }
    addEventListener(type: string, listener: (event: any) => void): void {
      let set = this.#listeners.get(type); if (!set) { set = new Set(); this.#listeners.set(type, set); } set.add(listener);
    }
    send(data: string): void { this.sent.push(data); }
    close(): void { this.readyState = 3; }
    #emit(type: string, event: any): void { for (const listener of this.#listeners.get(type) ?? []) listener(event); }
  }
  (globalThis as any).WebSocket = FakeWebSocket;
  t.after(() => { (globalThis as any).WebSocket = OriginalWebSocket; });
  const connection = new CdpConnection('target-1', 'ws://127.0.0.1:9222/devtools/page/1');
  await assert.rejects(() => connection.send('Runtime.enable'), (error: any) => error?.code === 'CDP_WEBSOCKET_DESTINATION_CHANGED');
});


test('relay result bearer endpoint stays bound to relay authority outside explicit loopback development', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-relay-result-authority-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const make = (relayUrl: string, resultUrl: string | undefined, allowLoopbackInsecure = false) => new LocalAgentRelayRunner({
    stateDir,
    relayUrl,
    resultUrl,
    sessionTokenFile: path.join(stateDir, 'session.token'),
    identity: new DeviceIdentityStore(stateDir, { platform: 'linux' }),
    localAgentBaseUrl: 'http://127.0.0.1:47100',
    agentToken: 'a'.repeat(32),
    allowLoopbackInsecure
  });

  assert.doesNotThrow(() => make('wss://relay.example.test/device', 'https://relay.example.test/v1/device-result'));
  for (const unsafe of [
    'https://evil.example.test/v1/device-result',
    'https://relay.example.test:444/v1/device-result',
    'https://relay.example.test/other',
    'https://relay.example.test/v1/device-result?next=elsewhere'
  ]) {
    assert.throws(() => make('wss://relay.example.test/device', unsafe));
  }

  assert.doesNotThrow(() => make(
    'ws://127.0.0.1:8788/device',
    'http://localhost:8789/v1/device-result',
    true
  ));
});


test('local control-plane bind hosts are literal loopback only', async (t) => {
  assert.equal(requireLiteralLoopbackBindHost('127.0.0.1', 'test'), '127.0.0.1');
  assert.equal(requireLiteralLoopbackBindHost('::1', 'test'), '::1');
  assert.equal(requireLiteralLoopbackBindHost('[::1]', 'test'), '::1');
  for (const unsafe of ['0.0.0.0', '::', 'localhost', '192.168.1.10', '10.0.0.4', 'example.test']) {
    assert.throws(
      () => requireLiteralLoopbackBindHost(unsafe, 'test'),
      (error: any) => error?.code === 'UNSAFE_LOCAL_BIND_HOST'
    );
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-local-bind-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = createRuntime({ allowedRoots: [root], allowedExecutables: ['node'] });
  const agent = createLocalAgentServer({
    runtime,
    token: 'b'.repeat(64),
    permissions: { allowedCapabilities: ['computer.inspect'], allowedRoots: [root] }
  });
  t.after(() => agent.close());
  await assert.rejects(
    () => agent.listen('0.0.0.0', 0),
    (error: any) => error?.code === 'UNSAFE_LOCAL_BIND_HOST'
  );
});

test('MCP startup preserves the shared loopback guard behind explicit public-edge authority', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const serverSource = await fs.readFile(path.join(root, 'apps/mcp-server/src/server.ts'), 'utf8');
  const edgeSource = await fs.readFile(path.join(root, 'apps/mcp-server/src/public-edge.ts'), 'utf8');
  assert.match(serverSource, /resolveMcpBindHost\(process\.env, publicEdge\)/);
  assert.match(edgeSource, /requireLiteralLoopbackBindHost\(env\.OPERATOR_MCP_HOST \?\? '127\.0\.0\.1'/);
  assert.match(edgeSource, /OPERATOR_MCP_PUBLIC_BIND_ACK/);
  assert.match(edgeSource, /TLS_TERMINATES_UPSTREAM/);
  assert.doesNotMatch(serverSource, /const host = process\.env\.OPERATOR_MCP_HOST \?\?/);
});

test('shared HTTP ingress policy keeps request resources bounded', () => {
  const server = http.createServer();
  applyBoundedHttpServerPolicy(server);
  assert.equal(server.headersTimeout, 10_000);
  assert.equal(server.requestTimeout, 30_000);
  assert.equal(server.keepAliveTimeout, 5_000);
  assert.equal(server.maxRequestsPerSocket, 100);
  assert.equal(server.maxHeadersCount, 64);
});


test('all relay HTTP entry points apply the shared bounded ingress policy', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  for (const relative of [
    'apps/relay-server/src/relay-hub.ts',
    'apps/relay-server/src/result-service.ts',
    'apps/relay-server/src/control-service.ts'
  ]) {
    const source = await fs.readFile(path.join(root, relative), 'utf8');
    assert.match(source, /applyBoundedHttpServerPolicy\(server\)/, relative);
  }
});
