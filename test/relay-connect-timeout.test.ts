import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { RelayClient, type RelaySocketLike } from '../src/core/relay-client.ts';

class NeverOpeningSocket implements RelaySocketLike {
  readyState = 0;
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  #listeners = new Map<string, Set<(event: any) => void>>();

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void {
    let listeners = this.#listeners.get(type);
    if (!listeners) { listeners = new Set(); this.#listeners.set(type, listeners); }
    listeners.add(listener);
  }

  removeEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(): void { throw new Error('stalled socket must never reach send'); }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    for (const listener of [...(this.#listeners.get('close') ?? [])]) listener({ code, reason });
  }
}

test('relay connect timeout closes a socket that never opens and returns control to reconnect loop', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-relay-timeout-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const identity = new DeviceIdentityStore(stateDir);
  await identity.loadOrCreate('Timeout Test PC');

  const sockets: NeverOpeningSocket[] = [];
  let sleepCalls = 0;
  let client!: RelayClient;
  client = new RelayClient({
    stateDir,
    url: 'ws://127.0.0.1:9999/relay',
    allowLoopbackInsecureWs: true,
    identity,
    socketFactory: () => {
      const socket = new NeverOpeningSocket();
      sockets.push(socket);
      return socket;
    },
    getSessionToken: async () => 'bounded-session-token',
    onDelivery: async () => { throw new Error('no delivery expected'); },
    connectTimeoutMs: 100,
    sleep: async () => {
      sleepCalls += 1;
      client.stop();
    }
  });

  const started = performance.now();
  await client.run();
  const elapsed = performance.now() - started;

  assert.equal(sockets.length, 1);
  assert.equal(sleepCalls, 1);
  assert.equal(sockets[0].closeCalls.some((call) => call.code === 4001 && call.reason === 'connect timeout'), true);
  assert.ok(elapsed < 2_000, `stalled relay connection should be bounded, elapsed=${elapsed}ms`);
});
