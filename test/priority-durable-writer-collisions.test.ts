import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorldModelStore } from '../src/core/world-model.ts';
import { ExecutionOptimizerStore } from '../src/core/execution-optimizer.ts';
import { EnterprisePolicyStore } from '../src/core/enterprise-policy.ts';

async function root(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-priority-writer-collision-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('independent world observations preserve every source claim under simultaneous writers', async t => {
  const dir = await root(t);
  const stores = Array.from({ length: 5 }, () => new WorldModelStore(dir));
  await Promise.all(Array.from({ length: 20 }, (_, i) => stores[i % stores.length]!.observe({
    entity: { key: 'service:synthetic', type: 'service', scopeKey: 'project:synthetic', label: 'Synthetic service' },
    source: 'synthetic-observer-' + i,
    domain: 'process',
    evidenceDigest: crypto.createHash('sha256').update('source:' + i).digest('hex'),
    facts: { status: 'healthy' },
    confidence: 0.9
  })));
  const current = await new WorldModelStore(dir).resolveFact('service:synthetic', 'status');
  assert.equal(current.status, 'resolved');
  assert.equal(current.value, 'healthy');
  assert.equal(current.claims.length, 20, 'concurrent process-local queues must never lose independent source evidence');
  assert.equal(new Set(current.claims.map(c => c.source)).size, 20);
});

test('independent optimizer writers preserve unique receipts while deduplicating concurrent retries', async t => {
  const dir = await root(t);
  const stores = Array.from({ length: 6 }, () => new ExecutionOptimizerStore(dir));
  const receipts = Array.from({ length: 24 }, (_, i) =>
    crypto.createHash('sha256').update('synthetic-receipt:' + i).digest('hex'));
  await Promise.all(receipts.map((receipt, i) => stores[i % stores.length]!.record(
    'synthetic-rollout', 'guarded', { verified: true, durationMs: 100, retries: 0, costUnits: 0 }, receipt)));
  const initial = (await new ExecutionOptimizerStore(dir).inspect()).find(x => x.context === 'synthetic-rollout' && x.strategy === 'guarded');
  assert.ok(initial);
  assert.equal(initial.samples, 24);
  assert.equal(initial.verified, 24);
  await Promise.all(receipts.map((receipt, i) => stores[(i + 1) % stores.length]!.record(
    'synthetic-rollout', 'guarded', { verified: true, durationMs: 100 }, receipt)));
  const again = (await new ExecutionOptimizerStore(dir).inspect()).find(x => x.context === 'synthetic-rollout' && x.strategy === 'guarded');
  assert.equal(again?.samples, 24);
  assert.equal(again?.verified, 24);
});

test('independent enterprise policy updates increment the durable generation without lost writes', async t => {
  const dir = await root(t);
  const stores = Array.from({ length: 5 }, () => new EnterprisePolicyStore(dir));
  const result = await Promise.all(Array.from({ length: 12 }, (_, i) => stores[i % stores.length]!.configure({
    roles: [{ id: 'reader-' + i, capabilities: ['file.read'], rootPrefixes: [],
      maxRisk: 'read' as const, environments: [], projectPrefixes: [], deviceGroups: [] }],
    bindings: []
  })));
  const last = await new EnterprisePolicyStore(dir).inspect();
  assert.equal(last.generation, 12);
  assert.equal(new Set(result.map(x => x.generation)).size, 12,
    'an independent writer must never commit an already used policy generation');
  assert.equal(last.roles.length, 1);
});
