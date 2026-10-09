import assert from 'node:assert/strict';
import test from 'node:test';
import { CdpConnection } from '../src/capabilities/browser-cdp-connection.ts';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readonly url: string;
  readyState = 0;
  #listeners = new Map<string, Set<() => void>>();
  constructor(url: string) { this.url = url; FakeSocket.instances.push(this); }
  addEventListener(type: string, listener: () => void, _options?: unknown): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }
  emit(type: string): void {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const listener of this.#listeners.get(type) ?? []) listener();
  }
  close(): void { this.emit('close'); }
  send(_payload: string): void { throw new Error('synthetic websocket send rejection'); }
}

function mockSocket(t: test.TestContext): () => FakeSocket {
  const original = globalThis.WebSocket;
  FakeSocket.instances.length = 0;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = original; });
  return () => FakeSocket.instances.at(-1)!;
}

test('early CDP socket close immediately rejects a connection still opening', async (t) => {
  const socket = mockSocket(t);
  const connection = new CdpConnection('test', 'ws://127.0.0.1:9222/devtools/page/test');
  const pending = connection.send('Runtime.evaluate');
  socket().emit('close');
  await assert.rejects(
    Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(Error('ready stayed pending')), 250))]),
    (error: any) => error?.code === 'CDP_CONNECTION_CLOSED'
  );
});

test('CDP synchronous send failure immediately detaches abort listener', async (t) => {
  const socket = mockSocket(t);
  const connection = new CdpConnection('test', 'ws://127.0.0.1:9222/devtools/page/test');
  socket().emit('open');
  const controller = new AbortController();
  let attached = 0;
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = ((...args: Parameters<typeof originalAdd>) => {
    if (args[0] === 'abort') attached++;
    return originalAdd(...args);
  }) as typeof controller.signal.addEventListener;
  controller.signal.removeEventListener = ((...args: Parameters<typeof originalRemove>) => {
    if (args[0] === 'abort') attached--;
    return originalRemove(...args);
  }) as typeof controller.signal.removeEventListener;
  await assert.rejects(connection.send('Runtime.evaluate', {}, 8_000, controller.signal),
    (error: any) => error?.code === 'CDP_COMMAND_SEND_FAILED');
  assert.equal(attached, 0, 'failed send must not leave abort listener active');
  connection.close();
});
