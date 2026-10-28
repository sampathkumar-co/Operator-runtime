import assert from 'node:assert/strict';
import test from 'node:test';
import { CdpConnection } from '../src/capabilities/browser-cdp-connection.ts';

class StubSocket {
  static OPEN = 1;
  static last: StubSocket;
  readonly url: string;
  readyState = 0;
  readonly sent: string[] = [];
  #listeners = new Map<string, Set<(event: { data?: string }) => void>>();

  constructor(url: string) { this.url = url; StubSocket.last = this; }

  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  emit(type: string, data?: string): void {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const listener of this.#listeners.get(type) ?? []) listener({ data });
  }

  send(payload: string): void { this.sent.push(payload); }
  close(): void { this.emit('close'); }
  reply(payload: unknown): void { this.emit('message', JSON.stringify(payload)); }
}

function setup(t: import('node:test').TestContext) {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = StubSocket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = original; });
  const connection = new CdpConnection('page-1', 'ws://127.0.0.1:9222/devtools/page/page-1');
  const socket = StubSocket.last;
  socket.emit('open');
  t.after(() => connection.close());
  return { connection, socket };
}

async function dispatchedRequest(connection: CdpConnection, socket: StubSocket) {
  const promise = connection.send('Runtime.evaluate', { expression: '1+1' });
  await new Promise<void>(resolve => setImmediate(resolve));
  const id = JSON.parse(socket.sent.at(-1)!).id as number;
  assert.ok(Number.isSafeInteger(id));
  return { promise, id };
}

test('C03 missing/coerced/contradictory CDP command outcomes never become success', async t => {
  const { connection, socket } = setup(t);
  const invalidOutcomes: Record<string, unknown>[] = [
    {},
    { result: null },
    { result: [] },
    { result: false },
    { result: 'ok' },
    { result: {}, error: { code: -32000, message: 'failed' } },
    { error: 'failed' },
    { error: {} },
    { error: { code: 'invalid', message: 'failed' } }
  ];
  for (const outcome of invalidOutcomes) {
    const { promise, id } = await dispatchedRequest(connection, socket);
    socket.reply({ id, ...outcome });
    await assert.rejects(promise, (error: any) =>
      error?.code === 'CDP_RESPONSE_INVALID' &&
      error?.retryable === false &&
      error?.details?.executionPhase === 'post_dispatch' &&
      error?.details?.sideEffectState === 'unknown' &&
      error?.details?.remedy === 'reobserve_before_retry');
  }
});

test('C03 valid CDP result and protocol error stay distinct', async t => {
  const { connection, socket } = setup(t);
  const successful = await dispatchedRequest(connection, socket);
  socket.reply({ id: successful.id, result: { result: { type: 'number', value: 2 } } });
  assert.deepEqual(await successful.promise, { result: { type: 'number', value: 2 } });
  const failed = await dispatchedRequest(connection, socket);
  socket.reply({ id: failed.id, error: { code: -32000, message: 'execution context was destroyed' } });
  await assert.rejects(failed.promise,
    (error: any) => error?.code === 'CDP_COMMAND_FAILED' && error?.details?.code === -32000);
});

test('C03 forged non-string flattened sessions cannot reach WebSocket dispatch', async t => {
  const { connection, socket } = setup(t);
  for (const invalid of [[], ['session'], {}, { length: 4 }, 42, '', 'x'.repeat(257)]) {
    await assert.rejects(connection.sendInSession(invalid as string, 'Runtime.evaluate'),
      (error: any) => error?.code === 'INVALID_CDP_SESSION');
  }
  assert.equal(socket.sent.length, 0);
});
