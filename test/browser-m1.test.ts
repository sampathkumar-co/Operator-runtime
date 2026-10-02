import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { BrowserCdpProvider } from '../src/capabilities/browser-cdp.ts';
import { performSemanticInteraction } from '../src/capabilities/browser-cdp-frames.ts';

type Listener = (event: any) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  static downloadScenario: 'complete' | 'unrelated-first' | 'simultaneous' | 'canceled' | 'target-closed' = 'complete';
  static autoAttachDisabled = 0;
  static #instances = new Set<FakeWebSocket>();
  readonly url: string;
  readyState = 0;
  #listeners = new Map<string, Set<Listener>>();
  #state = { url: 'https://example.test/start', title: 'Start', readyState: 'complete', typedValue: '' };
  #oopif: boolean;

  constructor(url: string) {
    this.url = url;
    this.#oopif = url.includes('/oopif');
    FakeWebSocket.#instances.add(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.#emit('open', {});
    });
  }

  addEventListener(type: string, listener: Listener, options?: { once?: boolean }): void {
    const wrapped = options?.once ? (event: any) => { this.removeEventListener(type, wrapped); listener(event); } : listener;
    const bucket = this.#listeners.get(type) ?? new Set<Listener>();
    bucket.add(wrapped);
    this.#listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
    let result: Record<string, unknown> = {};

    if (message.method === 'Target.setAutoAttach') {
      if (message.params?.autoAttach === false) FakeWebSocket.autoAttachDisabled += 1;
      this.#reply(message.id, result, message.sessionId);
      if (this.#oopif && !message.sessionId && message.params?.autoAttach === true) {
        queueMicrotask(() => this.#emit('message', { data: JSON.stringify({
          method: 'Target.attachedToTarget',
          params: {
            sessionId: 'frame-session-1',
            targetInfo: {
              targetId: 'frame-target-1',
              type: 'iframe',
              title: 'Frame',
              url: 'https://frame.example.test/widget'
            },
            waitingForDebugger: false
          }
        }) }));
      }
      return;
    }

    if (message.method === 'Page.navigate') {
      this.#state.url = String(message.params?.url ?? this.#state.url);
      this.#state.title = 'Destination';
      result = { frameId: 'frame-1' };
    } else if (message.method === 'Page.getFrameTree') {
      result = { frameTree: { frame: { id: 'frame-main', url: this.#state.url } } };
    } else if (message.method === 'Input.dispatchMouseEvent') {
      if (message.params?.type === 'mouseReleased') FakeWebSocket.#emitDownload();
    } else if (message.method === 'Runtime.evaluate') {
      const expression = String(message.params?.expression ?? '');
      if (expression.includes('semanticLocatorFunction')) {
        const inFrame = message.sessionId === 'frame-session-1';
        const count = this.#oopif ? (inFrame ? 1 : 0) : 1;
        result = {
          result: {
            value: {
              count,
              matches: count ? [{ tag: 'input', role: 'textbox', name: 'Email', identity: '#email', geometry: { x: 10, y: 20, width: 100, height: 30 }, context: { frameDepth: 0, shadowDepth: 0 } }] : []
            }
          }
        };
      } else if (expression.includes('interactionFunction') || expression.includes('No matching semantic element')) {
        const frameOnlyMismatch = this.#oopif && message.sessionId !== 'frame-session-1';
        result = frameOnlyMismatch
          ? { result: { value: { ok: false, error: 'No matching semantic element was found.' } } }
          : { result: { value: { ok: true, matched: { tag: 'input', role: 'textbox', name: 'Email', value: '' }, after: { name: 'Email', role: 'textbox', value: 'hello@example.com' } } } };
        if (!frameOnlyMismatch) this.#state.typedValue = 'hello@example.com';
      } else if (expression.includes('headings') && expression.includes('controls')) {
        const frame = message.sessionId === 'frame-session-1';
        result = {
          result: {
            value: {
              headings: [frame ? 'Frame Example' : 'Example'],
              controls: [{ tag: 'input', role: 'textbox', name: 'Email', type: 'text', href: '', context: { frameDepth: 0, shadowDepth: 0 } }],
              forms: [],
              textExcerpt: frame ? 'Frame page' : 'Example page'
            }
          }
        };
      } else {
        result = {
          result: {
            value: message.sessionId === 'frame-session-1'
              ? { url: 'https://frame.example.test/widget', title: 'Frame', readyState: 'complete' }
              : { ...this.#state }
          }
        };
      }
    } else if (message.method === 'Accessibility.getFullAXTree') {
      result = { nodes: [{ role: { value: 'textbox' }, name: { value: 'Email' }, value: { value: this.#state.typedValue } }] };
    }
    this.#reply(message.id, result, message.sessionId);
  }

  close(): void {
    this.readyState = 3;
    this.#emit('close', {});
  }

  static #broadcast(method: string, params: Record<string, unknown>): void {
    for (const socket of FakeWebSocket.#instances) {
      if (!socket.url.includes('/browser')) continue;
      socket.#emit('message', { data: JSON.stringify({ method, params }) });
    }
  }

  static #emitDownload(): void {
    const scenario = FakeWebSocket.downloadScenario;
    if (scenario === 'target-closed') {
      queueMicrotask(() => FakeWebSocket.#broadcast('Target.targetDestroyed', { targetId: 'tab-1' }));
      return;
    }
    if (scenario === 'unrelated-first') {
      queueMicrotask(() => {
        FakeWebSocket.#broadcast('Browser.downloadWillBegin', { guid: 'other', frameId: 'frame-other', url: 'https://other.test/file' });
        FakeWebSocket.#broadcast('Browser.downloadProgress', { guid: 'other', state: 'completed' });
      });
    }
    queueMicrotask(() => {
      FakeWebSocket.#broadcast('Browser.downloadWillBegin', { guid: 'expected', frameId: 'frame-main', url: 'https://example.test/file', suggestedFilename: 'file.txt' });
      if (scenario === 'simultaneous') {
        FakeWebSocket.#broadcast('Browser.downloadWillBegin', { guid: 'second', frameId: 'frame-main', url: 'https://example.test/second' });
      } else {
        FakeWebSocket.#broadcast('Browser.downloadProgress', { guid: 'expected', state: scenario === 'canceled' ? 'canceled' : 'completed', receivedBytes: 10, totalBytes: 10 });
      }
    });
  }

  #reply(id: number, result: Record<string, unknown>, sessionId?: string): void {
    queueMicrotask(() => this.#emit('message', { data: JSON.stringify({ id, result, ...(sessionId ? { sessionId } : {}) }) }));
  }

  #emit(type: string, event: any): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

async function withCdpServer(t: any, fn: (endpoint: string) => Promise<void>, websocketPath = '/fake') {
  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 'tab-1', type: 'page', title: 'Start', url: 'https://example.test/start', webSocketDebuggerUrl: `ws://127.0.0.1${websocketPath}` }]));
      return;
    }
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1/browser' }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bad address');
  await fn(`http://127.0.0.1:${address.port}`);
}

test('browser navigate verifies resulting destination over a persistent CDP target session', async (t) => {
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });
  t.after(() => Object.defineProperty(globalThis, 'WebSocket', { value: original, configurable: true, writable: true }));

  await withCdpServer(t, async (endpoint) => {
    const provider = new BrowserCdpProvider(endpoint);
    t.after(() => provider.close());
    const result = await provider.execute({
      id: 'nav-1', capability: 'browser.navigate', risk: 'external',
      input: { targetId: 'tab-1', url: 'https://example.test/destination' }, provenance: { kind: 'chatgpt' }
    });
    assert.equal(result.ok, true);
    assert.equal((result.output as any).url, 'https://example.test/destination');
    assert.equal(result.evidence.some((item) => item.kind === 'postcondition' && item.status === 'pass'), true);
  });
});

test('browser inspect returns bounded semantic page state rather than raw HTML', async (t) => {
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });
  t.after(() => Object.defineProperty(globalThis, 'WebSocket', { value: original, configurable: true, writable: true }));

  await withCdpServer(t, async (endpoint) => {
    const provider = new BrowserCdpProvider(endpoint);
    t.after(() => provider.close());
    const result = await provider.execute({ id: 'inspect-1', capability: 'browser.inspect', risk: 'read', input: { targetId: 'tab-1' }, provenance: { kind: 'chatgpt' } });
    assert.equal(result.ok, true);
    const page = (result.output as any).page;
    assert.deepEqual(page.accessibility[0], { role: 'textbox', name: 'Email' });
    assert.deepEqual(page.semantic.headings, ['Example']);
    assert.deepEqual(page.frames, []);
    assert.equal(JSON.stringify(result.output).includes('<html'), false);
  });
});

test('browser interact returns element-state verification after unique semantic preflight', async (t) => {
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });
  t.after(() => Object.defineProperty(globalThis, 'WebSocket', { value: original, configurable: true, writable: true }));

  await withCdpServer(t, async (endpoint) => {
    const provider = new BrowserCdpProvider(endpoint);
    t.after(() => provider.close());
    const result = await provider.execute({
      id: 'type-1', capability: 'browser.interact', risk: 'external', provenance: { kind: 'chatgpt' },
      input: { targetId: 'tab-1', operation: 'type', target: { role: 'textbox', name: 'Email' }, value: 'hello@example.com' }
    });
    assert.equal(result.ok, true);
    assert.equal((result.output as any).matched.name, 'Email');
    assert.equal((result.output as any).frame, undefined);
    assert.equal(result.evidence.some((item) => item.kind === 'postcondition'), true);
  });
});

test('browser inspect and interact traverse a cross-origin iframe through flattened CDP sessions', async (t) => {
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });
  t.after(() => Object.defineProperty(globalThis, 'WebSocket', { value: original, configurable: true, writable: true }));

  await withCdpServer(t, async (endpoint) => {
    const provider = new BrowserCdpProvider(endpoint);
    t.after(() => provider.close());

    const inspected = await provider.execute({
      id: 'inspect-oopif', capability: 'browser.inspect', risk: 'read', input: { targetId: 'tab-1' }, provenance: { kind: 'chatgpt' }
    });
    assert.equal(inspected.ok, true);
    const frames = (inspected.output as any).page.frames;
    assert.equal(frames.length, 1);
    assert.equal(frames[0].targetId, 'frame-target-1');
    assert.equal(frames[0].semantic.headings[0], 'Frame Example');

    const interacted = await provider.execute({
      id: 'type-oopif', capability: 'browser.interact', risk: 'external', provenance: { kind: 'chatgpt' },
      input: { targetId: 'tab-1', operation: 'type', target: { role: 'textbox', name: 'Email' }, value: 'hello@example.com' }
    });
    assert.equal(interacted.ok, true);
    assert.equal((interacted.output as any).frame.targetId, 'frame-target-1');
    assert.equal((interacted.output as any).matched.name, 'Email');
  }, '/oopif');
});

test('browser provider rejects credential-bearing and non-http navigation URLs', async () => {
  const provider = new BrowserCdpProvider('http://127.0.0.1:9222');
  const credentialed = await provider.execute({ id: 'bad1', capability: 'browser.navigate', risk: 'external', input: { url: 'https://user:pass@example.com/' }, provenance: { kind: 'chatgpt' } });
  assert.equal(credentialed.ok, false);
  assert.equal(credentialed.error?.code, 'URL_CREDENTIALS_DENIED');

  const fileUrl = await provider.execute({ id: 'bad2', capability: 'browser.navigate', risk: 'external', input: { url: 'file:///etc/passwd' }, provenance: { kind: 'chatgpt' } });
  assert.equal(fileUrl.ok, false);
  assert.equal(fileUrl.error?.code, 'URL_SCHEME_DENIED');
});

test('internal tab close verifies target disappearance without enlarging MCP surface', async (t) => {
  let exists = true;
  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(exists ? [{ id: 'close-me', type: 'page', title: 'Temp', url: 'https://example.test/' }] : []));
      return;
    }
    if (req.url === '/json/close/close-me') {
      exists = false;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Target is closing');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bad address');
  const provider = new BrowserCdpProvider(`http://127.0.0.1:${address.port}`);
  const result = await provider.execute({ id: 'close-1', capability: 'browser.tab.close', risk: 'write', input: { targetId: 'close-me' }, provenance: { kind: 'runtime' } });
  assert.equal(result.ok, true);
  assert.equal((result.output as any).closed, true);
});

test('semantic pointer actions use native CDP input and reject a target that changes after preflight', async () => {
  const nativeEvents: any[] = [];
  let locateCalls = 0;
  const sample = { tag: 'button', role: 'button', name: 'Save', identity: '#save', geometry: { x: 10, y: 20, width: 80, height: 30 }, context: { frameDepth: 0, shadowDepth: 0 } };
  const session = {
    on() { return () => undefined; },
    async send(method: string, params: any) {
      if (method === 'Runtime.evaluate') {
        locateCalls += 1;
        return { result: { value: { count: 1, matches: [sample] } } };
      }
      if (method === 'Input.dispatchMouseEvent') nativeEvents.push(params);
      return {};
    },
    async sendInSession() { return {}; }
  };
  const clicked = await performSemanticInteraction(session as any, { operation: 'click', target: { role: 'button', name: 'Save' }, value: null });
  assert.equal(locateCalls, 2);
  assert.deepEqual(nativeEvents.map((event) => event.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.equal(clicked.value.ok, true);

  let changedCalls = 0;
  const changed = { ...sample, identity: '#replacement', geometry: { ...sample.geometry, x: 100 } };
  const unstable = {
    on() { return () => undefined; },
    async send(method: string) {
      if (method === 'Runtime.evaluate') return { result: { value: { count: 1, matches: [changedCalls++ === 0 ? sample : changed] } } };
      if (method === 'Input.dispatchMouseEvent') throw new Error('stale target must not receive input');
      return {};
    },
    async sendInSession() { return {}; }
  };
  await assert.rejects(
    () => performSemanticInteraction(unstable as any, { operation: 'click', target: { role: 'button', name: 'Save' }, value: null }),
    (error: any) => error?.code === 'BROWSER_STALE_TARGET'
  );
});

test('download tracking binds events to the initiating target frame and fails closed on ambiguity', async (t) => {
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });
  t.after(() => Object.defineProperty(globalThis, 'WebSocket', { value: original, configurable: true, writable: true }));
  await withCdpServer(t, async (endpoint) => {
    const run = async (scenario: typeof FakeWebSocket.downloadScenario) => {
      FakeWebSocket.downloadScenario = scenario;
      const provider = new BrowserCdpProvider(endpoint);
      try {
        return await provider.execute({
          id: `download-${scenario}`, capability: 'browser.interact', risk: 'external',
          input: { targetId: 'tab-1', operation: 'click', target: { role: 'textbox', name: 'Email' }, expectDownload: true, downloadTimeoutMs: 1000 },
          provenance: { kind: 'runtime' }
        });
      } finally { provider.close(); }
    };

    const unrelatedFirst = await run('unrelated-first');
    assert.equal(unrelatedFirst.ok, true, unrelatedFirst.error?.message);
    assert.equal((unrelatedFirst.output as any).download.guid, 'expected');

    const simultaneous = await run('simultaneous');
    assert.equal(simultaneous.ok, false);
    assert.equal(simultaneous.error?.code, 'BROWSER_DOWNLOAD_AMBIGUOUS');

    const canceled = await run('canceled');
    assert.equal(canceled.ok, false);
    assert.equal(canceled.error?.code, 'BROWSER_DOWNLOAD_CANCELED');

    const closed = await run('target-closed');
    assert.equal(closed.ok, false);
    assert.equal(closed.error?.code, 'BROWSER_DOWNLOAD_TARGET_CLOSED');
  });
});

test('OOPIF discovery cancellation returns promptly and disables auto-attach', async (t) => {
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });
  t.after(() => Object.defineProperty(globalThis, 'WebSocket', { value: original, configurable: true, writable: true }));
  FakeWebSocket.autoAttachDisabled = 0;
  await withCdpServer(t, async (endpoint) => {
    const provider = new BrowserCdpProvider(endpoint); t.after(() => provider.close());
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const started = performance.now();
    const result = await provider.execute({
      id: 'cancel-oopif', capability: 'browser.inspect', risk: 'read', input: { targetId: 'tab-1' }, provenance: { kind: 'runtime' }
    }, { signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'EXECUTION_ABORTED');
    assert.ok(performance.now() - started < 250);
    assert.ok(FakeWebSocket.autoAttachDisabled >= 1);
  }, '/oopif');
});
