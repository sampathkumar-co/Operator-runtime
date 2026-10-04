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
  static mutationNoise = false;
  static mutationVersion = 0;
  static localTreeProgress = false;
  static localTreeVersion = 0;
  static dateWidgetDelay = false;
  static dateSelectEvaluations = 0;
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
      if (FakeWebSocket.dateWidgetDelay && expression.includes('Calendar date postcondition failed')) {
        FakeWebSocket.dateSelectEvaluations += 1;
        result = FakeWebSocket.dateSelectEvaluations === 1
          ? { result: { value: { ok: false, recoverable: true, error: 'No supported visible calendar widget was associated with the observed input.' } } }
          : { result: { value: { ok: true, matched: { tag: 'input', role: 'textbox', name: 'Date', identity: '#date', value: '' }, after: { value: '03/17/2016', date: '2016-03-17', widget: 'calendar', navigationSteps: 9 } } } };
      } else if (expression.includes('semanticLocatorFunction')) {
        const inFrame = message.sessionId === 'frame-session-1';
        const count = this.#oopif ? (inFrame ? 1 : 0) : 1;
        result = {
          result: {
            value: {
              count,
              matches: count ? [{
                tag: 'input', role: 'textbox', name: 'Email', identity: '#email',
                ...(FakeWebSocket.mutationNoise ? { documentMutationVersion: (FakeWebSocket.mutationVersion += 1) } : {}),
                ...(FakeWebSocket.localTreeProgress ? { subtreeSignature: { descendantCount: 1, digest: `tree-${FakeWebSocket.localTreeVersion += 1}` } } : {}),
                geometry: { x: 10, y: 20, width: 100, height: 30 }, context: { frameDepth: 0, shadowDepth: 0 }
              }] : []
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
    assert.equal((result.output as any).settle.settled, true);
    assert.equal((result.output as any).settle.reason, 'quiet');
    assert.equal(typeof (result.output as any).settle.lastMutationVersion, 'number');
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
  const beforeScroll = { ...sample, geometry: { ...sample.geometry, y: 900 } };
  const session = {
    on() { return () => undefined; },
    async send(method: string, params: any) {
      if (method === 'Runtime.evaluate') {
        locateCalls += 1;
        return { result: { value: { count: 1, matches: [locateCalls === 1 ? beforeScroll : sample] } } };
      }
      if (method === 'Input.dispatchMouseEvent') nativeEvents.push(params);
      return {};
    },
    async sendInSession() { return {}; }
  };
  const clicked = await performSemanticInteraction(session as any, { operation: 'click', target: { role: 'button', name: 'Save' }, value: null });
  assert.equal(locateCalls, 3);
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


test('native browser keyboard actions focus the unique semantic target and dispatch bounded CDP keys', async () => {
  const keyEvents: any[] = [];
  const sample = { tag: 'input', role: 'textbox', name: 'Command', identity: '#command', value: 'echo hi', active: false, geometry: { coordinateSpace: 'viewport', x: 10, y: 20, width: 120, height: 30 }, context: { frameDepth: 0, shadowDepth: 0 } };
  const session = {
    on() { return () => undefined; },
    async send(method: string, params: any) {
      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression ?? '');
        if (expression.includes('semanticLocatorFunction')) return { result: { value: { count: 1, matches: [sample] } } };
        if (expression.includes('interactionFunction')) return { result: { value: { ok: true, matched: sample, after: { ...sample, active: true } } } };
      }
      if (method === 'Input.dispatchKeyEvent') keyEvents.push(params);
      return {};
    },
    async sendInSession() { return {}; }
  };

  const enter = await performSemanticInteraction(session as any, { operation: 'key_press', target: { role: 'textbox', name: 'Command' }, value: null, key: 'Enter' });
  assert.equal(enter.value.ok, true);
  assert.deepEqual(keyEvents.map((event) => [event.type, event.key]), [['keyDown', 'Enter'], ['keyUp', 'Enter']]);

  keyEvents.length = 0;
  const chord = await performSemanticInteraction(session as any, { operation: 'hotkey', target: { role: 'textbox', name: 'Command' }, value: null, keys: ['Control', 'a'] });
  assert.equal(chord.value.ok, true);
  assert.deepEqual(keyEvents.map((event) => [event.type, event.key]), [
    ['keyDown', 'Control'], ['keyDown', 'a'], ['keyUp', 'a'], ['keyUp', 'Control']
  ]);
  assert.equal(keyEvents[1].modifiers & 2, 2);

  keyEvents.length = 0;
  const inserted = await performSemanticInteraction(session as any, { operation: 'keyboard_text', target: { ref: 'b-command' }, value: 'echo ready' });
  assert.equal(inserted.value.ok, true);
  assert.equal(keyEvents.length, 'echo ready'.length * 2);
  assert.deepEqual(keyEvents.slice(0, 4).map((event) => [event.type, event.key, event.text]), [
    ['keyDown', 'e', 'e'], ['keyUp', 'e', undefined], ['keyDown', 'c', 'c'], ['keyUp', 'c', undefined]
  ]);
  assert.equal((inserted.value.after as any).nativeKeyboardTextDispatched, true);
});

test('select_date tolerates one asynchronous calendar-open turn and still completes as one browser action', async (t) => {
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });
  FakeWebSocket.dateWidgetDelay = true;
  FakeWebSocket.dateSelectEvaluations = 0;
  t.after(() => {
    FakeWebSocket.dateWidgetDelay = false;
    FakeWebSocket.dateSelectEvaluations = 0;
    Object.defineProperty(globalThis, 'WebSocket', { value: original, configurable: true, writable: true });
  });
  await withCdpServer(t, async (endpoint) => {
    const provider = new BrowserCdpProvider(endpoint); t.after(() => provider.close());
    const result = await provider.execute({
      id: 'date-select-1', capability: 'browser.interact', risk: 'external',
      input: { targetId: 'tab-1', operation: 'select_date', target: { ref: 'b-date' }, value: '2016-03-17' },
      provenance: { kind: 'runtime' }
    });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(FakeWebSocket.dateSelectEvaluations, 2);
    assert.equal((result.output as any).stateDelta.progress, true);
    const postcondition = result.evidence?.find((item: any) => item.kind === 'postcondition');
    assert.equal(postcondition?.data?.after?.date, '2016-03-17');
  });
});

test('browser provider prevents a second equivalent no-progress action and preserves side-effect truth', async (t) => {
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });
  t.after(() => Object.defineProperty(globalThis, 'WebSocket', { value: original, configurable: true, writable: true }));
  await withCdpServer(t, async (endpoint) => {
    const provider = new BrowserCdpProvider(endpoint); t.after(() => provider.close());
    const action = (id: string) => provider.execute({
      id, capability: 'browser.interact', risk: 'external',
      input: { targetId: 'tab-1', operation: 'click', target: { role: 'textbox', name: 'Email' } },
      provenance: { kind: 'runtime' }
    });
    const first = await action('no-progress-1');
    assert.equal(first.ok, true, first.error?.message);
    assert.equal((first.output as any).stateDelta.progress, false);
    assert.equal((first.output as any).stateDelta.repeatedNoProgress, 1);

    const second = await action('no-progress-2');
    assert.equal(second.ok, false);
    assert.equal(second.error?.code, 'BROWSER_NO_PROGRESS');
    assert.equal(second.error?.retryable, false);
    assert.equal(second.error?.sideEffectState, 'known');
    assert.equal((second.error?.details as any)?.repeatedNoProgress, 2);
  });
});

test('browser progress ignores unrelated document mutation-version noise', async (t) => {
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });
  FakeWebSocket.mutationNoise = true;
  FakeWebSocket.mutationVersion = 0;
  t.after(() => {
    FakeWebSocket.mutationNoise = false;
    FakeWebSocket.mutationVersion = 0;
    Object.defineProperty(globalThis, 'WebSocket', { value: original, configurable: true, writable: true });
  });
  await withCdpServer(t, async (endpoint) => {
    const provider = new BrowserCdpProvider(endpoint); t.after(() => provider.close());
    const first = await provider.execute({
      id: 'mutation-noise-1', capability: 'browser.interact', risk: 'external',
      input: { targetId: 'tab-1', operation: 'click', target: { role: 'textbox', name: 'Email' } },
      provenance: { kind: 'runtime' }
    });
    assert.equal(first.ok, true, first.error?.message);
    assert.equal((first.output as any).stateDelta.progress, false);
    assert.equal((first.output as any).stateDelta.repeatedNoProgress, 1);
  });
});

test('target-local subtree change counts as browser progress', async (t) => {
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });
  FakeWebSocket.localTreeProgress = true;
  FakeWebSocket.localTreeVersion = 0;
  t.after(() => {
    FakeWebSocket.localTreeProgress = false;
    FakeWebSocket.localTreeVersion = 0;
    Object.defineProperty(globalThis, 'WebSocket', { value: original, configurable: true, writable: true });
  });
  await withCdpServer(t, async (endpoint) => {
    const provider = new BrowserCdpProvider(endpoint); t.after(() => provider.close());
    const result = await provider.execute({
      id: 'local-tree-progress-1', capability: 'browser.interact', risk: 'external',
      input: { targetId: 'tab-1', operation: 'click', target: { role: 'textbox', name: 'Email' } },
      provenance: { kind: 'runtime' }
    });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal((result.output as any).stateDelta.progress, true);
  });
});

test('browser no-progress detection groups parameter-varied drag attempts against unchanged state', async (t) => {
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });
  t.after(() => Object.defineProperty(globalThis, 'WebSocket', { value: original, configurable: true, writable: true }));
  await withCdpServer(t, async (endpoint) => {
    const provider = new BrowserCdpProvider(endpoint); t.after(() => provider.close());
    const drag = (id: string, deltaY: number) => provider.execute({
      id, capability: 'browser.interact', risk: 'external',
      input: { targetId: 'tab-1', operation: 'drag_by', target: { role: 'textbox', name: 'Email' }, deltaX: 0, deltaY },
      provenance: { kind: 'runtime' }
    });
    const first = await drag('drag-family-1', 80);
    assert.equal(first.ok, true, first.error?.message);
    assert.equal((first.output as any).stateDelta.progress, false);
    assert.equal((first.output as any).stateDelta.repeatedNoProgress, 1);

    const second = await drag('drag-family-2', 240);
    assert.equal(second.ok, false);
    assert.equal(second.error?.code, 'BROWSER_NO_PROGRESS');
    assert.deepEqual((second.error?.details as any)?.actionFamily, { family: 'drag-displacement' });
    assert.equal((second.error?.details as any)?.repeatedNoProgress, 2);
  });
});

test('browser.verify independently reports VERIFIED and NOT_COMPLETE from public semantic state', async (t) => {
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });
  t.after(() => Object.defineProperty(globalThis, 'WebSocket', { value: original, configurable: true, writable: true }));
  await withCdpServer(t, async (endpoint) => {
    const provider = new BrowserCdpProvider(endpoint); t.after(() => provider.close());
    const verified = await provider.execute({
      id: 'verify-1', capability: 'browser.verify', risk: 'read',
      input: { targetId: 'tab-1', target: { role: 'textbox', name: 'Email' }, expect: { exists: true, titleContains: 'Start' } },
      provenance: { kind: 'runtime' }
    });
    assert.equal(verified.ok, true, verified.error?.message);
    assert.equal((verified.output as any).status, 'VERIFIED');

    const notComplete = await provider.execute({
      id: 'verify-2', capability: 'browser.verify', risk: 'read',
      input: { targetId: 'tab-1', target: { role: 'textbox', name: 'Email' }, expect: { expanded: true } },
      provenance: { kind: 'runtime' }
    });
    assert.equal(notComplete.ok, true, notComplete.error?.message);
    assert.equal((notComplete.output as any).status, 'NOT_COMPLETE');
  });
});


test('click_relative stays inside an observed object and dispatches the verified relative point', async () => {
  const nativeEvents: any[] = [];
  const sample = { tag: 'div', role: 'pointer', name: 'Canvas cell', identity: '#cell', actionable: true, geometry: { coordinateSpace: 'viewport', frameDepth: 0, x: 100, y: 200, width: 80, height: 40 }, context: { frameDepth: 0, shadowDepth: 0 } };
  const session = {
    on() { return () => undefined; },
    async send(method: string, params: any) {
      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression ?? '');
        if (expression.includes('observedRelativePointFunction')) return { result: { value: { ok: true, local: { x: 120, y: 230 } } } };
        if (expression.includes('semanticLocatorFunction')) return { result: { value: { count: 1, matches: [sample] } } };
      }
      if (method === 'Input.dispatchMouseEvent') nativeEvents.push(params);
      return {};
    },
    async sendInSession() { return {}; }
  };
  const result = await performSemanticInteraction(session as any, {
    operation: 'click_relative',
    target: { ref: 'b-test-1' },
    value: null,
    xRatio: 0.25,
    yRatio: 0.75
  });
  assert.equal(result.value.ok, true);
  assert.deepEqual(nativeEvents.map((event) => [event.type, event.x, event.y]), [
    ['mouseMoved', 120, 230],
    ['mousePressed', 120, 230],
    ['mouseReleased', 120, 230]
  ]);
});


test('click_relative accepts bounded observed-local pixel coordinates', async () => {
  const nativeEvents: any[] = [];
  const sample = { tag: 'div', role: 'pointer', name: 'Canvas cell', identity: '#cell', actionable: true, geometry: { coordinateSpace: 'viewport', frameDepth: 0, x: 100, y: 200, width: 80, height: 40 }, context: { frameDepth: 0, shadowDepth: 0 } };
  const session = {
    on() { return () => undefined; },
    async send(method: string, params: any) {
      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression ?? '');
        if (expression.includes('observedRelativePointFunction')) return { result: { value: { ok: true, local: { x: 110, y: 215 }, offset: { xPx: 10, yPx: 15 } } } };
        if (expression.includes('semanticLocatorFunction')) return { result: { value: { count: 1, matches: [sample] } } };
      }
      if (method === 'Input.dispatchMouseEvent') nativeEvents.push(params);
      return {};
    },
    async sendInSession() { return {}; }
  };
  const result = await performSemanticInteraction(session as any, {
    operation: 'click_relative', target: { ref: 'b-test-px' }, value: null, xPx: 10, yPx: 15
  });
  assert.equal(result.value.ok, true);
  assert.deepEqual(nativeEvents.map((event) => [event.type, event.x, event.y]), [
    ['mouseMoved', 110, 215], ['mousePressed', 110, 215], ['mouseReleased', 110, 215]
  ]);
});

test('browser provider rejects a non-scrollable target before dispatch', async (t) => {
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });
  t.after(() => Object.defineProperty(globalThis, 'WebSocket', { value: original, configurable: true, writable: true }));
  await withCdpServer(t, async (endpoint) => {
    const provider = new BrowserCdpProvider(endpoint); t.after(() => provider.close());
    const result = await provider.execute({
      id: 'scroll-invalid-target', capability: 'browser.interact', risk: 'external',
      input: { targetId: 'tab-1', operation: 'scroll', target: { ref: 'observed-scroll-1' }, deltaX: 0, deltaY: 180 },
      provenance: { kind: 'runtime' }
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'BROWSER_TARGET_NOT_SCROLLABLE');
    assert.equal(result.error?.retryable, true);
    assert.equal(result.error?.sideEffectState, 'none');
    assert.equal(result.error?.executionPhase, 'pre_dispatch');
  });
});

test('browser scroll uses native CDP wheel input scoped to an observed target', async () => {
  const nativeEvents: any[] = [];
  const sample = { tag: 'div', role: 'pointer', name: 'Scrollable list', identity: '#list', actionable: true, documentMutationVersion: 3, scroll: { top: 20, left: 0, scrollHeight: 500, scrollWidth: 100, clientHeight: 120, clientWidth: 100, canScrollY: true, canScrollX: false }, geometry: { coordinateSpace: 'viewport', frameDepth: 0, x: 20, y: 40, width: 120, height: 100 }, context: { frameDepth: 0, shadowDepth: 0 } };
  const session = {
    on() { return () => undefined; },
    async send(method: string, params: any) {
      if (method === 'Runtime.evaluate') return { result: { value: { count: 1, matches: [sample] } } };
      if (method === 'Input.dispatchMouseEvent') nativeEvents.push(params);
      return {};
    },
    async sendInSession() { return {}; }
  };
  const result = await performSemanticInteraction(session as any, {
    operation: 'scroll', target: { ref: 'b-scroll' }, value: null, deltaX: 0, deltaY: 180
  });
  assert.equal(result.value.ok, true);
  assert.deepEqual(nativeEvents, [
    { type: 'mouseMoved', x: 80, y: 90, button: 'none', buttons: 0 },
    { type: 'mouseWheel', x: 80, y: 90, deltaX: 0, deltaY: 180, button: 'none', buttons: 0 }
  ]);
});

test('drag_between revalidates two observed refs and uses native center-to-center input', async () => {
  const nativeEvents: any[] = [];
  const source = { tag: 'div', role: 'pointer', name: 'Card', identity: '#source', actionable: true, geometry: { coordinateSpace: 'viewport', frameDepth: 0, x: 10, y: 20, width: 40, height: 20 }, context: { frameDepth: 0, shadowDepth: 0 } };
  const destination = { tag: 'div', role: 'pointer', name: 'Drop zone', identity: '#destination', actionable: true, geometry: { coordinateSpace: 'viewport', frameDepth: 0, x: 210, y: 120, width: 60, height: 40 }, context: { frameDepth: 0, shadowDepth: 0 } };
  const session = {
    on() { return () => undefined; },
    async send(method: string, params: any) {
      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression ?? '');
        const sample = expression.includes('b-destination') ? destination : source;
        return { result: { value: { count: 1, matches: [sample] } } };
      }
      if (method === 'Input.dispatchMouseEvent') nativeEvents.push(params);
      return {};
    },
    async sendInSession() { return {}; }
  };
  const result = await performSemanticInteraction(session as any, {
    operation: 'drag_between',
    target: { ref: 'b-source' },
    toTarget: { ref: 'b-destination' },
    value: null
  });
  assert.equal(result.value.ok, true);
  assert.equal((result.value as any).destination.identity, '#destination');
  assert.deepEqual(nativeEvents[0], { type: 'mouseMoved', x: 30, y: 30, button: 'none', buttons: 0 });
  assert.deepEqual(nativeEvents[1], { type: 'mousePressed', x: 30, y: 30, button: 'left', buttons: 1, clickCount: 1 });
  assert.deepEqual(nativeEvents.at(-1), { type: 'mouseReleased', x: 240, y: 140, button: 'left', buttons: 0, clickCount: 1 });
  assert.ok(nativeEvents.length > 6);
});
