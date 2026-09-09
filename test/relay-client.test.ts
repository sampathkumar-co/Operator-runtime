import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { RelayClient, reconnectDelay, validateRelayUrl, type RelaySocketLike } from '../src/core/relay-client.ts';

class FakeSocket implements RelaySocketLike {
  readyState = 0;
  sent: any[] = [];
  #listeners = new Map<string, Set<(event: any) => void>>();
  onSend?: (frame: any) => void;

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void {
    let set = this.#listeners.get(type);
    if (!set) { set = new Set(); this.#listeners.set(type, set); }
    set.add(listener);
  }

  removeEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  open(): void { this.readyState = 1; this.#emit('open', {}); }
  server(frame: any): void { this.#emit('message', { data: JSON.stringify(frame) }); }
  error(): void { this.#emit('error', {}); }

  send(data: string): void {
    const frame = JSON.parse(data);
    this.sent.push(frame);
    this.onSend?.(frame);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit('close', { code, reason });
  }

  #emit(type: string, event: any): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(event);
  }
}

async function stateDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test('relay sends signed outbound hello, processes one delivery, persists ACK cursor, and resumes from it', async (t) => {
  const state = await stateDir(t, 'operator-relay-basic-');
  const identity = new DeviceIdentityStore(state);
  await identity.loadOrCreate('Relay Test PC');
  const sockets: FakeSocket[] = [];
  const delivered: any[] = [];
  let client!: RelayClient;

  const factory = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    socket.onSend = (frame) => {
      if (frame.type === 'hello') {
        void (async () => {
          const signatureOk = await identity.verify(Buffer.from(JSON.stringify(frame.payload), 'utf8'), frame.signature);
          assert.equal(signatureOk, true);
          assert.equal(frame.sessionToken, 'ephemeral-session-token');
          assert.equal(frame.payload.resumeAfterSeq, sockets.length === 1 ? 0 : 1);
          socket.server({ type: 'welcome', protocol: 1, connectionId: `conn-${sockets.length}`, resumeFromSeq: frame.payload.resumeAfterSeq, heartbeatMs: 60_000 });
          if (sockets.length === 1) {
            socket.server({ type: 'delivery', seq: 1, id: 'delivery-1', kind: 'task.dispatch', payload: { taskId: 't1' } });
          } else {
            client.stop();
            socket.close();
          }
        })();
      }
      if (frame.type === 'ack' && frame.seq === 1) socket.close();
    };
    queueMicrotask(() => socket.open());
    return socket;
  };

  client = new RelayClient({
    stateDir: state,
    url: 'ws://127.0.0.1:9999/relay',
    allowLoopbackInsecureWs: true,
    identity,
    socketFactory: factory,
    getSessionToken: async () => 'ephemeral-session-token',
    onDelivery: async (delivery) => { delivered.push(delivery); },
    sleep: async () => {}
  });

  await client.run();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, 'delivery-1');
  assert.equal((await client.state()).lastAckedServerSeq, 1);
  assert.equal((await client.state()).processing, undefined);
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].sent.some((frame) => frame.type === 'ack' && frame.seq === 1), true);
});

test('uncertain delivery after a crash is reconciled instead of automatically replayed', async (t) => {
  const state = await stateDir(t, 'operator-relay-recovery-');
  const identity = new DeviceIdentityStore(state);
  await identity.loadOrCreate('Recovery PC');
  await fs.writeFile(path.join(state, 'relay-client.json'), JSON.stringify({
    version: 1,
    lastAckedServerSeq: 0,
    processing: { seq: 1, id: 'uncertain-1', startedAt: '2026-09-09T12:00:00.000Z' }
  }, null, 2));

  let ordinaryCalls = 0;
  let recoveryCalls = 0;
  let client!: RelayClient;
  const socket = new FakeSocket();
  socket.onSend = (frame) => {
    if (frame.type === 'hello') {
      assert.deepEqual(frame.payload.pendingRecovery, { seq: 1, id: 'uncertain-1' });
      socket.server({ type: 'welcome', protocol: 1, connectionId: 'recovery-conn', resumeFromSeq: 0, heartbeatMs: 60_000 });
      socket.server({ type: 'delivery', seq: 1, id: 'uncertain-1', kind: 'task.dispatch', payload: { taskId: 't1' } });
    }
    if (frame.type === 'ack' && frame.recovered === true) {
      client.stop();
      socket.close();
    }
  };

  client = new RelayClient({
    stateDir: state,
    url: 'ws://localhost:9999/relay',
    allowLoopbackInsecureWs: true,
    identity,
    socketFactory: () => { queueMicrotask(() => socket.open()); return socket; },
    getSessionToken: async () => 'session',
    onDelivery: async () => { ordinaryCalls += 1; },
    onRecovery: async ({ delivery, processing }) => {
      recoveryCalls += 1;
      assert.equal(delivery.id, processing.id);
      return 'ack';
    },
    sleep: async () => {}
  });

  await client.run();
  assert.equal(ordinaryCalls, 0);
  assert.equal(recoveryCalls, 1);
  assert.deepEqual(await client.state(), { version: 1, lastAckedServerSeq: 1 });
});

test('handler uncertainty persists processing state and refuses blind replay without recovery callback', async (t) => {
  const state = await stateDir(t, 'operator-relay-uncertain-');
  const identity = new DeviceIdentityStore(state);
  await identity.loadOrCreate('Uncertain PC');
  let calls = 0;
  const sockets: FakeSocket[] = [];

  const client = new RelayClient({
    stateDir: state,
    url: 'ws://127.0.0.1:9999/relay',
    allowLoopbackInsecureWs: true,
    identity,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      socket.onSend = (frame) => {
        if (frame.type !== 'hello') return;
        socket.server({ type: 'welcome', protocol: 1, connectionId: `uncertain-${sockets.length}`, resumeFromSeq: 0, heartbeatMs: 60_000 });
        socket.server({ type: 'delivery', seq: 1, id: 'maybe-ran', kind: 'task.dispatch', payload: {} });
      };
      queueMicrotask(() => socket.open());
      return socket;
    },
    getSessionToken: async () => 'session',
    onDelivery: async () => { calls += 1; throw new Error('simulated crash-window failure'); },
    sleep: async () => {}
  });

  await assert.rejects(client.run(), (error: any) => error?.code === 'RELAY_RECOVERY_REQUIRED');
  assert.equal(calls, 1);
  const persisted = await client.state();
  assert.equal(persisted.lastAckedServerSeq, 0);
  assert.deepEqual(persisted.processing && { seq: persisted.processing.seq, id: persisted.processing.id }, { seq: 1, id: 'maybe-ran' });
  assert.ok(sockets.length >= 2);
});

test('relay URL policy requires TLS except explicit loopback development and backoff stays bounded', () => {
  assert.match(validateRelayUrl('wss://relay.example.com/operator'), /^wss:/);
  assert.match(validateRelayUrl('ws://127.0.0.1:9000/operator', true), /^ws:/);
  assert.throws(() => validateRelayUrl('ws://relay.example.com/operator', true), (error: any) => error?.code === 'RELAY_TLS_REQUIRED');
  assert.throws(() => validateRelayUrl('wss://user:pass@relay.example.com/operator'), (error: any) => error?.code === 'RELAY_URL_INVALID');
  assert.equal(reconnectDelay(0, 0), 250);
  assert.ok(reconnectDelay(5, 0.5) >= 7_000);
  assert.ok(reconnectDelay(50, 1) <= 30_000);
});
