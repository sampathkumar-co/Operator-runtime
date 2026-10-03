import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canRetryUncertainRelayDelivery, LocalAgentRelayRunner } from '../apps/local-agent/src/relay-agent.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';
import { LocalActionExecutionStore } from '../apps/local-agent/src/action-execution-store.ts';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { RelayResultStore } from '../src/core/relay-result-store.ts';
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
  const taskId = crypto.randomUUID();
  assert.equal(canRetryUncertainRelayDelivery({ ...base, kind: 'task', payload: { task: { operation: 'inspect', taskId } } }), true);
  assert.equal(canRetryUncertainRelayDelivery({ ...base, kind: 'task', payload: { task: { operation: 'resume', taskId, approvedActionId: 'forbidden' } } }), false);
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
    await readBody(req);
    if (req.url === '/v1/action-receipt') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'ACTION_EXECUTION_RECEIPT_NOT_FOUND' } }));
      return;
    }
    localHits += 1;
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


test('relay restart recovers a completed mutation with degraded audit evidence without replay', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-relay-durable-replay-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const identity = new DeviceIdentityStore(stateDir, { platform: 'linux' });
  const device = await identity.loadOrCreate('Durable Replay PC');
  const deliveryId = crypto.randomUUID();
  const storedResult = {
    ok: true,
    capability: 'file.create',
    provider: 'filesystem.native',
    output: { path: 'created-once.txt', created: true },
    evidence: [{ kind: 'audit_persistence', status: 'fail', message: 'Primary mutation completed, audit append degraded.' }],
    durationMs: 2
  };
  const outbox = new RelayResultStore(path.join(stateDir, 'relay-outbox'));
  await outbox.put(device.deviceId, 1, deliveryId, storedResult);

  let localHits = 0;
  const localBase = await listen(t, async (req, res) => {
    localHits += 1;
    await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      capability: 'file.create',
      provider: 'filesystem.native',
      output: { path: 'created-twice.txt', created: true },
      evidence: [],
      durationMs: 1
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
  const delivery = {
    type: 'delivery', seq: 1, id: deliveryId, kind: 'action',
    payload: {
      publicBoundary: false,
      approvalAuthority: { accountId: crypto.randomUUID(), deviceId: device.deviceId, generation: 1 },
      action: {
        id: crypto.randomUUID(), capability: 'file.create', risk: 'write',
        input: { path: 'created-once.txt', content: 'once' }, provenance: { kind: 'chatgpt' }
      }
    }
  };
  let resolveAck!: () => void;
  const acked = new Promise<void>((resolve) => { resolveAck = resolve; });
  const runner = new LocalAgentRelayRunner({
    stateDir,
    relayUrl: 'ws://127.0.0.1:65435/device',
    resultUrl: `${resultBase}/v1/device-result`,
    sessionTokenFile,
    identity,
    localAgentBaseUrl: localBase,
    agentToken: 'e'.repeat(64),
    allowLoopbackInsecure: true,
    socketFactory: (url) => new ScriptedRelaySocket(url, delivery, resolveAck)
  });

  const running = runner.run();
  await Promise.race([acked, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('relay ack timeout')), 3_000))]);
  runner.stop();
  await running;

  assert.equal(localHits, 0);
  assert.equal(resultBodies.length, 1);
  const submitted = JSON.parse(resultBodies[0]!);
  assert.deepEqual(submitted.result, storedResult);
  const remaining = JSON.parse(await fs.readFile(path.join(stateDir, 'relay-outbox', 'relay-results.json'), 'utf8'));
  assert.deepEqual(remaining.streams, []);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir, 'relay-client.json'), 'utf8')), { version: 1, lastAckedServerSeq: 1 });
});

test('transient result submission failure retries in place without replay or transport flap', { timeout: 8_000 }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-relay-result-retry-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const identity = new DeviceIdentityStore(stateDir, { platform: 'linux' });
  await identity.loadOrCreate('Result Retry PC');

  let localHits = 0;
  const localBase = await listen(t, async (req, res) => {
    localHits += 1;
    await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      capability: 'file.create',
      provider: 'filesystem.native',
      output: { path: 'created-once.txt', created: true },
      evidence: [],
      durationMs: 1
    }));
  });

  let resultHits = 0;
  const resultBodies: string[] = [];
  const resultBase = await listen(t, async (req, res) => {
    resultHits += 1;
    resultBodies.push(await readBody(req));
    if (resultHits === 1) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'RESULT_SERVICE_TEMPORARY' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  const sessionTokenFile = path.join(stateDir, 'relay-session.token');
  await fs.writeFile(sessionTokenFile, 'sessiontoken123456.signature123456', 'utf8');
  const deliveryId = crypto.randomUUID();
  const delivery = {
    type: 'delivery', seq: 1, id: deliveryId, kind: 'action',
    payload: {
      publicBoundary: false,
      approvalAuthority: { accountId: crypto.randomUUID(), deviceId: crypto.randomUUID(), generation: 1 },
      action: {
        id: crypto.randomUUID(), capability: 'file.create', risk: 'write',
        input: { path: 'created-once.txt', content: 'once' }, provenance: { kind: 'chatgpt' }
      }
    }
  };

  let resolveAck!: () => void;
  const acked = new Promise<void>((resolve) => { resolveAck = resolve; });
  let socketCreations = 0;
  const runner = new LocalAgentRelayRunner({
    stateDir,
    relayUrl: 'ws://127.0.0.1:65436/device',
    resultUrl: `${resultBase}/v1/device-result`,
    sessionTokenFile,
    identity,
    localAgentBaseUrl: localBase,
    agentToken: 'f'.repeat(64),
    allowLoopbackInsecure: true,
    socketFactory: (url) => {
      socketCreations += 1;
      return new ScriptedRelaySocket(url, delivery, resolveAck);
    }
  });

  const running = runner.run();
  await Promise.race([
    acked,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('relay result recovery ack timeout')), 5_000))
  ]);
  runner.stop();
  await running;

  assert.equal(localHits, 1, 'destructive local execution must not replay after a result-service outage');
  assert.equal(resultHits, 2, 'durable result should be retried in place');
  assert.equal(socketCreations, 1, 'a temporary result-service outage must not flap an otherwise healthy relay transport');
  assert.deepEqual(JSON.parse(resultBodies[0]!).result, JSON.parse(resultBodies[1]!).result);
  const outbox = JSON.parse(await fs.readFile(path.join(stateDir, 'relay-outbox', 'relay-results.json'), 'utf8'));
  assert.deepEqual(outbox.streams, []);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir, 'relay-client.json'), 'utf8')), { version: 1, lastAckedServerSeq: 1 });
});

test('result 401 escalates to credential reconnect and resubmits durable mutation without replay', { timeout: 8_000 }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-relay-result-auth-recovery-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const identity = new DeviceIdentityStore(stateDir, { platform: 'linux' });
  await identity.loadOrCreate('Result Auth Recovery PC');

  let localHits = 0;
  const localBase = await listen(t, async (req, res) => {
    localHits += 1;
    await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      capability: 'file.create',
      provider: 'filesystem.native',
      output: { path: 'auth-recovered-once.txt', created: true },
      evidence: [],
      durationMs: 1
    }));
  });

  let resultHits = 0;
  const authHeaders: string[] = [];
  const resultBase = await listen(t, async (req, res) => {
    resultHits += 1;
    authHeaders.push(String(req.headers.authorization ?? ''));
    await readBody(req);
    if (resultHits === 1) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'SESSION_REVOKED' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  let activeToken = 'stale-result-token';
  let connectionTokens = 0;
  const sessionCredentials = {
    async forConnection() {
      connectionTokens += 1;
      activeToken = connectionTokens === 1 ? 'stale-result-token' : 'fresh-result-token';
      return activeToken;
    },
    async forRequest() { return activeToken; },
    stop() {}
  };

  const deliveryId = crypto.randomUUID();
  const delivery = {
    type: 'delivery', seq: 1, id: deliveryId, kind: 'action',
    payload: {
      publicBoundary: false,
      approvalAuthority: { accountId: crypto.randomUUID(), deviceId: crypto.randomUUID(), generation: 1 },
      action: {
        id: crypto.randomUUID(), capability: 'file.create', risk: 'write',
        input: { path: 'auth-recovered-once.txt', content: 'once' }, provenance: { kind: 'chatgpt' }
      }
    }
  };

  let resolveAck!: () => void;
  const acked = new Promise<void>((resolve) => { resolveAck = resolve; });
  let socketCreations = 0;
  const runner = new LocalAgentRelayRunner({
    stateDir,
    relayUrl: 'ws://127.0.0.1:65437/device',
    resultUrl: `${resultBase}/v1/device-result`,
    sessionTokenFile: path.join(stateDir, 'unused-session.token'),
    sessionCredentials,
    identity,
    localAgentBaseUrl: localBase,
    agentToken: '1'.repeat(64),
    allowLoopbackInsecure: true,
    socketFactory: (url) => {
      socketCreations += 1;
      return new ScriptedRelaySocket(url, delivery, resolveAck);
    }
  });

  const running = runner.run();
  await Promise.race([
    acked,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('relay auth recovery ack timeout')), 5_000))
  ]);
  runner.stop();
  await running;

  assert.equal(localHits, 1, 'credential recovery must never replay the destructive local action');
  assert.equal(resultHits, 2);
  assert.equal(socketCreations, 2, '401 must leave the in-place transient retry path and recover connection credentials');
  assert.deepEqual(authHeaders, ['Bearer stale-result-token', 'Bearer fresh-result-token']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir, 'relay-client.json'), 'utf8')), { version: 1, lastAckedServerSeq: 1 });
});

test('local action deadline reconciles durable receipt without replaying mutation or flapping relay', { timeout: 6_000 }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-local-action-timeout-recovery-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const identity = new DeviceIdentityStore(stateDir, { platform: 'linux' });
  await identity.loadOrCreate('Local Receipt Recovery PC');
  const agentToken = '9'.repeat(64);
  let executions = 0;
  const runtime = {
    async execute(action: any) {
      executions += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        ok: true,
        capability: action.capability,
        provider: 'test.slow-runtime',
        output: { executions },
        evidence: [],
        durationMs: 300
      };
    }
  } as any;
  const receipts = new LocalActionExecutionStore(stateDir);
  const agent = createLocalAgentServer({
    runtime,
    token: agentToken,
    permissions: { allowedCapabilities: ['file.*'], allowedRoots: [stateDir] },
    actionExecutions: receipts
  });
  t.after(() => agent.close());
  const local = await agent.listen('127.0.0.1', 0);
  const localBase = `http://127.0.0.1:${local.port}`;

  let resultHits = 0;
  const resultBase = await listen(t, async (req, res) => {
    resultHits += 1;
    await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const sessionTokenFile = path.join(stateDir, 'relay-session.token');
  await fs.writeFile(sessionTokenFile, 'sessiontoken123456.signature123456', 'utf8');

  const deliveryId = crypto.randomUUID();
  const action = {
    id: crypto.randomUUID(),
    capability: 'file.create',
    risk: 'write',
    input: { path: 'deadline-receipt.txt', content: 'once' },
    provenance: { kind: 'chatgpt' }
  };
  const approvalAuthority = { accountId: crypto.randomUUID(), deviceId: crypto.randomUUID(), generation: 1 };
  const delivery = {
    type: 'delivery', seq: 1, id: deliveryId, kind: 'action',
    payload: { approvalAuthority, action }
  };
  let resolveAck!: () => void;
  const acked = new Promise<void>((resolve) => { resolveAck = resolve; });
  let socketCreations = 0;
  const runner = new LocalAgentRelayRunner({
    stateDir,
    relayUrl: 'ws://127.0.0.1:65438/device',
    resultUrl: `${resultBase}/v1/device-result`,
    sessionTokenFile,
    identity,
    localAgentBaseUrl: localBase,
    agentToken,
    localRequestTimeoutMs: 100,
    allowLoopbackInsecure: true,
    socketFactory: (url) => {
      socketCreations += 1;
      return new ScriptedRelaySocket(url, delivery, resolveAck);
    }
  });

  const running = runner.run();
  await Promise.race([
    acked,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('local action receipt recovery ack timeout')), 4_000))
  ]);
  runner.stop();
  await running;

  assert.equal(executions, 1, 'timed-out destructive request must not execute twice');
  assert.equal(socketCreations, 1, 'receipt reconciliation should recover before a healthy relay transport is replaced');
  assert.equal(resultHits, 1);
  const receipt = await receipts.lookup(action as any, approvalAuthority);
  assert.equal(receipt.status, 'completed');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir, 'relay-client.json'), 'utf8')), { version: 1, lastAckedServerSeq: 1 });
});

test('durable task request timeout reconnects and retries through task state without indefinite stall', { timeout: 6_000 }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-task-timeout-recovery-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const identity = new DeviceIdentityStore(stateDir, { platform: 'linux' });
  await identity.loadOrCreate('Task Timeout Recovery PC');

  const taskId = crypto.randomUUID();
  let taskHits = 0;
  const localBase = await listen(t, async (req, res) => {
    await readBody(req);
    taskHits += 1;
    if (taskHits === 1) await new Promise((resolve) => setTimeout(resolve, 300));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, task: { id: taskId, state: 'PAUSED' } }));
  });
  let resultHits = 0;
  const resultBase = await listen(t, async (req, res) => {
    resultHits += 1;
    await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const sessionTokenFile = path.join(stateDir, 'relay-session.token');
  await fs.writeFile(sessionTokenFile, 'sessiontoken123456.signature123456', 'utf8');

  const deliveryId = crypto.randomUUID();
  const delivery = {
    type: 'delivery', seq: 1, id: deliveryId, kind: 'task',
    payload: {
      approvalAuthority: { accountId: crypto.randomUUID(), deviceId: crypto.randomUUID(), generation: 1 },
      task: { operation: 'inspect', taskId }
    }
  };
  let resolveAck!: () => void;
  const acked = new Promise<void>((resolve) => { resolveAck = resolve; });
  let socketCreations = 0;
  const runner = new LocalAgentRelayRunner({
    stateDir,
    relayUrl: 'ws://127.0.0.1:65439/device',
    resultUrl: `${resultBase}/v1/device-result`,
    sessionTokenFile,
    identity,
    localAgentBaseUrl: localBase,
    agentToken: '7'.repeat(64),
    localRequestTimeoutMs: 100,
    allowLoopbackInsecure: true,
    socketFactory: (url) => {
      socketCreations += 1;
      return new ScriptedRelaySocket(url, delivery, resolveAck);
    }
  });

  const running = runner.run();
  await Promise.race([
    acked,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('durable task timeout recovery ack timeout')), 4_000))
  ]);
  runner.stop();
  await running;

  assert.equal(taskHits, 2, 'durable task inspection should retry after the bounded local HTTP timeout');
  assert.equal(socketCreations, 2, 'uncertain durable task should reconnect once and reconcile through its durable state');
  assert.equal(resultHits, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir, 'relay-client.json'), 'utf8')), { version: 1, lastAckedServerSeq: 1 });
});

test('result submission timeout retries in place without replaying action or replacing healthy transport', { timeout: 6_000 }, async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-result-timeout-retry-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const identity = new DeviceIdentityStore(stateDir, { platform: 'linux' });
  await identity.loadOrCreate('Result Timeout Retry PC');

  let localHits = 0;
  const localBase = await listen(t, async (req, res) => {
    localHits += 1;
    await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      capability: 'file.create',
      provider: 'filesystem.native',
      output: { path: 'result-timeout-once.txt', created: true },
      evidence: [],
      durationMs: 1
    }));
  });
  let resultHits = 0;
  const resultBase = await listen(t, async (req, res) => {
    resultHits += 1;
    await readBody(req);
    if (resultHits === 1) await new Promise((resolve) => setTimeout(resolve, 300));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const sessionTokenFile = path.join(stateDir, 'relay-session.token');
  await fs.writeFile(sessionTokenFile, 'sessiontoken123456.signature123456', 'utf8');

  const deliveryId = crypto.randomUUID();
  const delivery = {
    type: 'delivery', seq: 1, id: deliveryId, kind: 'action',
    payload: {
      approvalAuthority: { accountId: crypto.randomUUID(), deviceId: crypto.randomUUID(), generation: 1 },
      action: {
        id: crypto.randomUUID(), capability: 'file.create', risk: 'write',
        input: { path: 'result-timeout-once.txt', content: 'once' }, provenance: { kind: 'chatgpt' }
      }
    }
  };
  let resolveAck!: () => void;
  const acked = new Promise<void>((resolve) => { resolveAck = resolve; });
  let socketCreations = 0;
  const runner = new LocalAgentRelayRunner({
    stateDir,
    relayUrl: 'ws://127.0.0.1:65440/device',
    resultUrl: `${resultBase}/v1/device-result`,
    sessionTokenFile,
    identity,
    localAgentBaseUrl: localBase,
    agentToken: '8'.repeat(64),
    resultSubmitTimeoutMs: 100,
    allowLoopbackInsecure: true,
    socketFactory: (url) => {
      socketCreations += 1;
      return new ScriptedRelaySocket(url, delivery, resolveAck);
    }
  });

  const running = runner.run();
  await Promise.race([
    acked,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('result submission timeout retry ack timeout')), 4_000))
  ]);
  runner.stop();
  await running;

  assert.equal(localHits, 1, 'result timeout must never replay the local mutation');
  assert.equal(resultHits, 2, 'timed-out result submission should retry from the durable outbox');
  assert.equal(socketCreations, 1, 'result-channel timeout must not flap the healthy relay transport');
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


test('oversized local relay result is converted to a bounded non-retryable failure and ACKed', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-relay-oversize-result-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const identity = new DeviceIdentityStore(stateDir, { platform: 'linux' });
  await identity.loadOrCreate('Oversize Result PC');
  let localHits = 0;
  const localBase = await listen(t, async (req, res) => {
    localHits += 1;
    await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      capability: 'visual.capture',
      provider: 'windows.uia',
      output: { captureId: crypto.randomUUID(), imageBase64: 'A'.repeat(300 * 1024) },
      evidence: [],
      durationMs: 1
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
  const delivery = {
    type: 'delivery', seq: 1, id: crypto.randomUUID(), kind: 'action',
    payload: {
      publicBoundary: false,
      approvalAuthority: { accountId: crypto.randomUUID(), deviceId: crypto.randomUUID(), generation: 1 },
      action: {
        id: crypto.randomUUID(), capability: 'visual.capture', risk: 'read',
        input: { source: 'screen', maxWidth: 1280, maxHeight: 720 }, provenance: { kind: 'chatgpt' }
      }
    }
  };
  let resolveAck!: () => void;
  const acked = new Promise<void>((resolve) => { resolveAck = resolve; });
  const runner = new LocalAgentRelayRunner({
    stateDir,
    relayUrl: 'ws://127.0.0.1:65434/device',
    resultUrl: `${resultBase}/v1/device-result`,
    sessionTokenFile,
    identity,
    localAgentBaseUrl: localBase,
    agentToken: 'd'.repeat(64),
    allowLoopbackInsecure: true,
    socketFactory: (url) => new ScriptedRelaySocket(url, delivery, resolveAck)
  });
  const running = runner.run();
  await Promise.race([acked, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('relay ack timeout')), 3_000))]);
  runner.stop();
  await running;

  assert.equal(localHits, 1);
  assert.equal(resultBodies.length, 1);
  assert.ok(Buffer.byteLength(resultBodies[0]!, 'utf8') < 256 * 1024);
  const submitted = JSON.parse(resultBodies[0]!);
  assert.equal(submitted.result?.ok, false);
  assert.equal(submitted.result?.capability, 'visual.capture');
  assert.equal(submitted.result?.provider, 'relay.boundary');
  assert.equal(submitted.result?.error?.code, 'RELAY_LOCAL_RESULT_TOO_LARGE');
  assert.equal(submitted.result?.error?.retryable, false);
  assert.match(submitted.result?.error?.message ?? '', /Do not retry automatically/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir, 'relay-client.json'), 'utf8')), { version: 1, lastAckedServerSeq: 1 });
});
