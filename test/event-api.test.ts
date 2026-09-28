import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { DurableEventRuntime } from '../src/core/event-runtime.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-event-api-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('stage13 private event API is authenticated, durable, idempotent and digest-only', async (t) => {
  const state = await temp(t);
  const events = new DurableEventRuntime(state);
  const runtime = new OperatorRuntime();
  const token = 'e'.repeat(64);
  const agent = createLocalAgentServer({
    runtime,
    token,
    events,
    permissions: { allowedCapabilities: [], allowedRoots: [] }
  });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const bound = await agent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${bound.port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const unauthorized = await fetch(`${base}/v1/events/waits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ eventType: 'github.pull_request.reviewed' })
  });
  assert.equal(unauthorized.status, 401);

  const waitId = crypto.randomUUID();
  const created = await fetch(`${base}/v1/events/waits`, {
    method: 'POST', headers,
    body: JSON.stringify({
      waitId,
      eventType: 'github.pull_request.reviewed',
      correlationKey: 'pr:42'
    })
  });
  assert.equal(created.status, 201);

  const event = {
    id: crypto.randomUUID(),
    type: 'github.pull_request.reviewed',
    correlationKey: 'pr:42',
    payloadDigest: crypto.createHash('sha256').update('reviewed').digest('hex'),
    occurredAt: new Date().toISOString(),
    payload: { authorization: 'must-not-be-persisted', body: 'secret material' }
  };
  const published = await fetch(`${base}/v1/events/publish`, {
    method: 'POST', headers, body: JSON.stringify(event)
  });
  assert.equal(published.status, 200);
  const first = await published.json() as any;
  assert.deepEqual(first.satisfiedWaitIds, [waitId]);

  const retry = await fetch(`${base}/v1/events/publish`, {
    method: 'POST', headers, body: JSON.stringify(event)
  });
  assert.equal(retry.status, 200);
  assert.deepEqual((await retry.json() as any).satisfiedWaitIds, [waitId]);

  const inspected = await fetch(`${base}/v1/events/waits/${waitId}`, { headers });
  assert.equal(inspected.status, 200);
  assert.equal((await inspected.json() as any).wait.state, 'SATISFIED');

  const raw = await fs.readFile(path.join(state, 'events.json'), 'utf8');
  assert.equal(raw.includes('must-not-be-persisted'), false);
  assert.equal(raw.includes('secret material'), false);
});

test('stage13 API can cancel waiting contracts without fabricating an event', async (t) => {
  const state = await temp(t);
  const events = new DurableEventRuntime(state);
  const runtime = new OperatorRuntime();
  const token = 'f'.repeat(64);
  const agent = createLocalAgentServer({
    runtime,
    token,
    events,
    permissions: { allowedCapabilities: [], allowedRoots: [] }
  });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const bound = await agent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${bound.port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const wait = await (await fetch(`${base}/v1/events/waits`, {
    method: 'POST', headers,
    body: JSON.stringify({ eventType: 'device.online', correlationKey: 'device:a' })
  })).json() as any;
  const cancelled = await fetch(`${base}/v1/events/waits/${wait.wait.id}/cancel`, { method: 'POST', headers });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json() as any).wait.state, 'CANCELLED');
});
