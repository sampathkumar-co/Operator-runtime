import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { AuditLog } from '../src/core/audit.ts';
import { PolicyEngine } from '../src/core/policy.ts';
import { RelayDeliveryStore } from '../src/core/relay-delivery-store.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

async function temp(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function metric(name: string, elapsedMs: number, operations: number): void {
  const perOp = elapsedMs / operations;
  console.log(`[perf] ${name}: ${operations} ops in ${elapsedMs.toFixed(1)} ms (${perOp.toFixed(3)} ms/op)`);
}

test('policy authorization remains comfortably sub-millisecond at scale', () => {
  const policy = new PolicyEngine();
  const root = path.resolve(os.tmpdir(), 'operator-perf-policy');
  const action = {
    id: 'perf-policy',
    capability: 'file.read',
    risk: 'read' as const,
    input: { path: path.join(root, 'file.txt') },
    provenance: { kind: 'chatgpt' as const }
  };
  const permissions = {
    allowedCapabilities: ['file.*'],
    allowedRoots: [root]
  };
  const operations = 50_000;
  const start = performance.now();
  for (let i = 0; i < operations; i += 1) policy.authorize(action, permissions);
  const elapsed = performance.now() - start;
  metric('policy-authorize', elapsed, operations);
  assert.ok(elapsed < 4_000, `Policy authorization regression: ${elapsed.toFixed(1)} ms for ${operations} operations.`);
});

test('redacting audit append and bounded tail stay within a generous IO budget', async (t) => {
  const state = await temp(t, 'operator-perf-audit-');
  const audit = new AuditLog(state);
  const operations = 250;
  const start = performance.now();
  for (let i = 0; i < operations; i += 1) {
    await audit.append({
      capability: 'performance.audit',
      result: 'success',
      risk: 'read',
      details: { sequence: i, token: `must-redact-${i}` }
    });
  }
  const events = await audit.tail(operations);
  const elapsed = performance.now() - start;
  metric('audit-append-tail', elapsed, operations);
  assert.equal(events.length, operations);
  assert.equal(JSON.stringify(events).includes('must-redact-'), false);
  const stat = await fs.stat(path.join(state, 'audit.ndjson'));
  assert.ok(stat.size < 512 * 1024, `Audit state unexpectedly large: ${stat.size} bytes.`);
  assert.ok(elapsed < 8_000, `Audit IO regression: ${elapsed.toFixed(1)} ms.`);
});

test('durable relay queue enqueue and contiguous ACK remain bounded', async (t) => {
  const state = await temp(t, 'operator-perf-relay-');
  const store = new RelayDeliveryStore(state);
  const deviceId = crypto.randomUUID();
  const operations = 75;
  const deliveries = [];
  const start = performance.now();
  for (let i = 0; i < operations; i += 1) {
    deliveries.push(await store.enqueue(deviceId, 'performance.delivery', { index: i, value: 'x'.repeat(64) }));
  }
  for (const delivery of deliveries) {
    await store.acknowledge(deviceId, delivery.seq, delivery.id);
  }
  const cursor = await store.cursor(deviceId);
  const elapsed = performance.now() - start;
  metric('relay-enqueue-ack', elapsed, operations * 2);
  assert.deepEqual(cursor, { lastAckedSeq: operations, highestEnqueuedSeq: operations });
  const stat = await fs.stat(path.join(state, 'relay-deliveries.json'));
  assert.ok(stat.size < 512 * 1024, `Relay state unexpectedly large: ${stat.size} bytes.`);
  assert.ok(elapsed < 15_000, `Relay persistence regression: ${elapsed.toFixed(1)} ms.`);
});

test('authenticated local-agent inspect round trips remain responsive', async (t) => {
  const root = await temp(t, 'operator-perf-agent-root-');
  const token = 'p'.repeat(64);
  const runtime = createRuntime({ allowedRoots: [root], allowedExecutables: ['node'] });
  const agent = createLocalAgentServer({
    runtime,
    token,
    permissions: { allowedCapabilities: ['computer.inspect'], allowedRoots: [root] }
  });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const bound = await agent.listen('127.0.0.1', 0);
  const url = `http://127.0.0.1:${bound.port}/v1/execute`;
  const operations = 25;
  const start = performance.now();
  for (let i = 0; i < operations; i += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: {
        id: `perf-inspect-${i}`,
        capability: 'computer.inspect',
        risk: 'read',
        input: {},
        provenance: { kind: 'chatgpt' }
      } })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).ok, true);
  }
  const elapsed = performance.now() - start;
  metric('local-agent-inspect', elapsed, operations);
  assert.ok(elapsed < 10_000, `Local-agent round-trip regression: ${elapsed.toFixed(1)} ms.`);
});
