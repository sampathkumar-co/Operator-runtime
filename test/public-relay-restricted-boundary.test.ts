import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canRetryUncertainRelayDelivery, LocalAgentRelayRunner } from '../apps/local-agent/src/relay-agent.ts';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import type { RelaySocketLike } from '../src/core/relay-client.ts';

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

async function readBody(req: http.IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text;
}

class ScriptedRelaySocket implements RelaySocketLike {
  readyState = 0;
  sent: string[] = [];
  #listeners = new Map<string, Set<(event: any) => void>>();
  readonly url: string;
  private readonly delivery: Record<string, unknown>;
  private readonly onAck: () => void;
  constructor(url: string, delivery: Record<string, unknown>, onAck: () => void) {
    this.url = url;
    this.delivery = delivery;
    this.onAck = onAck;
    queueMicrotask(() => this.#open());
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void {
    let set = this.#listeners.get(type);
    if (!set) { set = new Set(); this.#listeners.set(type, set); }
    set.add(listener);
  }
  removeEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }
  send(data: string): void {
    this.sent.push(data);
    const frame = JSON.parse(data);
    if (frame.type === 'hello') {
      queueMicrotask(() => this.#emit('message', { data: JSON.stringify({
        type: 'welcome', protocol: 1, connectionId: 'test-connection', resumeFromSeq: 0, heartbeatMs: 60_000
      }) }));
      setTimeout(() => this.#emit('message', { data: JSON.stringify(this.delivery) }), 0);
    } else if (frame.type === 'ack') this.onAck();
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit('close', {});
  }
  #open(): void {
    this.readyState = 1;
    this.#emit('open', {});
  }
  #emit(type: string, event: any): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

test('uncertain relay recovery retries only a validated read action when no stored result exists', () => {
  const base = {
    seq: 7,
    id: crypto.randomUUID(),
    kind: 'action',
    payload: { action: {
      id: crypto.randomUUID(), capability: 'git.diff', risk: 'read', input: {}, provenance: { kind: 'chatgpt' }
    } }
  };
  assert.equal(canRetryUncertainRelayDelivery(base), true);
  assert.equal(canRetryUncertainRelayDelivery({ ...base, payload: { action: { ...base.payload.action, risk: 'write' } } }), false);
  assert.equal(canRetryUncertainRelayDelivery({ ...base, payload: { action: { ...base.payload.action, provenance: { kind: 'observed' } } } }), false);
  assert.equal(canRetryUncertainRelayDelivery({ ...base, kind: 'task.dispatch' }), false);
});

test('missing crash-window result replays a read through the normal bounded execution path', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-public-read-recovery-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const identity = new DeviceIdentityStore(stateDir, { platform: 'linux' });
  await identity.loadOrCreate('Read Recovery PC');
  const deliveryId = crypto.randomUUID();
  await fs.writeFile(path.join(stateDir, 'relay-client.json'), JSON.stringify({
    version: 1,
    lastAckedServerSeq: 0,
    processing: { seq: 1, id: deliveryId, startedAt: '2026-09-22T04:56:29.297Z' }
  }, null, 2));
  let localHits = 0;
  const localBase = await listen(t, async (req, res) => {
    localHits += 1;
    await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, capability: 'git.diff', provider: 'git.native', output: { files: [] }, evidence: [], durationMs: 1 }));
  });
  const resultBase = await listen(t, async (req, res) => {
    await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const sessionTokenFile = path.join(stateDir, 'relay-session.token');
  await fs.writeFile(sessionTokenFile, 'sessiontoken123456.signature123456', 'utf8');
  const delivery = {
    type: 'delivery', seq: 1, id: deliveryId, kind: 'action',
    payload: { publicBoundary: true, approvalAuthority: { accountId: crypto.randomUUID(), deviceId: crypto.randomUUID(), generation: 1 }, action: {
      id: crypto.randomUUID(), capability: 'git.diff', risk: 'read', input: {}, provenance: { kind: 'chatgpt' }
    } }
  };
  let resolveAck!: () => void;
  const acked = new Promise<void>((resolve) => { resolveAck = resolve; });
  const runner = new LocalAgentRelayRunner({
    stateDir, relayUrl: 'ws://127.0.0.1:65433/device', resultUrl: `${resultBase}/v1/device-result`,
    sessionTokenFile, identity, localAgentBaseUrl: localBase, agentToken: 'c'.repeat(64),
    allowLoopbackInsecure: true, socketFactory: (url) => new ScriptedRelaySocket(url, delivery, resolveAck)
  });
  const running = runner.run();
  await Promise.race([acked, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('relay ack timeout')), 3_000))]);
  runner.stop();
  await running;
  assert.equal(localHits, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir, 'relay-client.json'), 'utf8')), { version: 1, lastAckedServerSeq: 1 });
});

test('public relay blocks restricted local output and leaves no ACKed outbox payload', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-public-boundary-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const secret = 'password=hunter2-public-boundary-test';
  let localHits = 0;
  const localBase = await listen(t, async (req, res) => {
    localHits += 1;
    await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, capability: 'file.read', provider: 'test-local',
      output: { content: secret }, evidence: [], durationMs: 1
    }));
  });

  const resultBodies: string[] = [];
  const resultBase = await listen(t, async (req, res) => {
    resultBodies.push(await readBody(req));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const sessionTokenFile = path.join(stateDir, 'relay-session.token');
  await fs.writeFile(sessionTokenFile, 'sessiontoken123456.signature123456', 'utf8');

  const deliveryId = crypto.randomUUID();
  const actionId = crypto.randomUUID();
  const delivery = {
    type: 'delivery', seq: 1, id: deliveryId, kind: 'action',
    payload: {
      publicBoundary: true,
      approvalAuthority: { accountId: crypto.randomUUID(), deviceId: crypto.randomUUID(), generation: 1 },
      action: {
        id: actionId, capability: 'file.read', risk: 'read',
        input: { path: 'safe-demo.txt' }, provenance: { kind: 'chatgpt' }
      }
    }
  };
  let resolveAck!: () => void;
  const acked = new Promise<void>((resolve) => { resolveAck = resolve; });
  const relayUrl = 'ws://127.0.0.1:65431/device';
  let socket!: ScriptedRelaySocket;
  const runner = new LocalAgentRelayRunner({
    stateDir,
    relayUrl,
    resultUrl: `${resultBase}/v1/device-result`,
    sessionTokenFile,
    identity: new DeviceIdentityStore(stateDir, { platform: 'linux' }),
    localAgentBaseUrl: localBase,
    agentToken: 'a'.repeat(64),
    allowLoopbackInsecure: true,
    socketFactory: (url) => {
      socket = new ScriptedRelaySocket(url, delivery, resolveAck);
      return socket;
    }
  });

  const running = runner.run();
  await Promise.race([
    acked,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('relay ack timeout')), 3_000))
  ]);
  runner.stop();
  await running;

  assert.equal(localHits, 1);
  assert.equal(resultBodies.length, 1);
  assert.doesNotMatch(resultBodies[0]!, /hunter2-public-boundary-test/);
  const submitted = JSON.parse(resultBodies[0]!);
  assert.equal(submitted.result?.error?.code, 'RESTRICTED_DATA_BLOCKED');
  const outboxFile = path.join(stateDir, 'relay-outbox', 'relay-results.json');
  const outbox = await fs.readFile(outboxFile, 'utf8');
  assert.doesNotMatch(outbox, /hunter2-public-boundary-test/);
  assert.deepEqual(JSON.parse(outbox).streams, []);
  assert.equal(socket.sent.some((frame) => frame.includes(secret)), false);
});

test('public relay blocks restricted action input before local execution', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-public-input-boundary-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const secret = 'password=hunter2-public-input-test';
  let localHits = 0;
  const localBase = await listen(t, async (req, res) => {
    localHits += 1;
    await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, evidence: [] }));
  });
  const resultBodies: string[] = [];
  const resultBase = await listen(t, async (req, res) => {
    resultBodies.push(await readBody(req));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const sessionTokenFile = path.join(stateDir, 'relay-session.token');
  await fs.writeFile(sessionTokenFile, 'sessiontoken123456.signature123456', 'utf8');
  const delivery = {
    type: 'delivery', seq: 1, id: crypto.randomUUID(), kind: 'action',
    payload: { publicBoundary: true, approvalAuthority: { accountId: crypto.randomUUID(), deviceId: crypto.randomUUID(), generation: 1 }, action: {
      id: crypto.randomUUID(), capability: 'file.create', risk: 'write',
      input: { path: 'safe-demo.txt', content: secret }, provenance: { kind: 'chatgpt' }
    } }
  };
  let resolveAck!: () => void;
  const acked = new Promise<void>((resolve) => { resolveAck = resolve; });
  const runner = new LocalAgentRelayRunner({
    stateDir, relayUrl: 'ws://127.0.0.1:65432/device',
    resultUrl: `${resultBase}/v1/device-result`, sessionTokenFile,
    identity: new DeviceIdentityStore(stateDir, { platform: 'linux' }),
    localAgentBaseUrl: localBase, agentToken: 'b'.repeat(64), allowLoopbackInsecure: true,
    socketFactory: (url) => new ScriptedRelaySocket(url, delivery, resolveAck)
  });
  const running = runner.run();
  await Promise.race([acked, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('relay ack timeout')), 3_000))]);
  runner.stop();
  await running;
  assert.equal(localHits, 0);
  assert.equal(resultBodies.length, 1);
  assert.doesNotMatch(resultBodies[0]!, /hunter2-public-input-test/);
  assert.equal(JSON.parse(resultBodies[0]!).result?.error?.code, 'RESTRICTED_DATA_BLOCKED');
  const outbox = await fs.readFile(path.join(stateDir, 'relay-outbox', 'relay-results.json'), 'utf8');
  assert.doesNotMatch(outbox, /hunter2-public-input-test/);
  assert.deepEqual(JSON.parse(outbox).streams, []);
});
