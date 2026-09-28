import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorldModelStore, worldValueDigest } from '../src/core/world-model.ts';

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-world-history-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('stage14 records atomic fact transitions without retaining old secret-bearing values', async (t) => {
  let now = new Date('2026-09-28T10:00:00.000Z');
  const world = new WorldModelStore(await temp(t), { clock: () => now });
  const base = {
    entity: { key: 'deployment:prod', type: 'deployment', scopeKey: 'project:app', label: 'Production' },
    source: 'verifier:deploy',
    domain: 'project' as const,
    confidence: 1,
    ttlMs: 60_000,
    relations: []
  };
  await world.observe({
    ...base,
    evidenceDigest: crypto.createHash('sha256').update('v1').digest('hex'),
    facts: { version: '1.0.0', health: 'healthy' }
  });
  now = new Date('2026-09-28T10:01:00.000Z');
  await world.observe({
    ...base,
    evidenceDigest: crypto.createHash('sha256').update('v2').digest('hex'),
    facts: { version: '2.0.0', health: 'healthy' }
  });

  const history = await world.history({ entityKey: 'deployment:prod', factKey: 'version' });
  assert.equal(history.length, 2);
  assert.equal(history[0]?.toValueDigest, worldValueDigest('2.0.0'));
  assert.equal(history[0]?.fromValueDigest, worldValueDigest('1.0.0'));
  assert.equal(history[1]?.fromValueDigest, undefined);
  assert.equal(JSON.stringify(history).includes('2.0.0'), false);
});

test('stage14 does not create a fake transition when the source re-observes the same value', async (t) => {
  let now = new Date('2026-09-28T11:00:00.000Z');
  const world = new WorldModelStore(await temp(t), { clock: () => now });
  const observation = {
    entity: { key: 'service:api', type: 'service', scopeKey: 'project:api', label: 'API' },
    source: 'health-check',
    domain: 'application' as const,
    evidenceDigest: crypto.createHash('sha256').update('same').digest('hex'),
    facts: { health: 'healthy' },
    confidence: 0.9,
    ttlMs: 60_000
  };
  await world.observe(observation);
  now = new Date('2026-09-28T11:00:30.000Z');
  await world.observe(observation);
  assert.equal((await world.history({ entityKey: 'service:api', factKey: 'health' })).length, 1);
});
