import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorldModelStore } from '../src/core/world-model.ts';

async function tempDir(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-world-model-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('stage6 merges cross-application claims for the same entity without losing source evidence', async (t) => {
  const store = new WorldModelStore(await tempDir(t));
  await store.observe({
    entity: { key: 'order:42', type: 'order', scopeKey: 'shop:main', label: 'Order 42' },
    source: 'browser.checkout', domain: 'browser', evidenceDigest: 'a'.repeat(64),
    facts: { status: 'paid', total: 1200 }, confidence: 0.9
  });
  await store.observe({
    entity: { key: 'order:42', type: 'order', scopeKey: 'shop:main', label: 'Order 42' },
    source: 'postgres.orders', domain: 'database', evidenceDigest: 'b'.repeat(64),
    facts: { status: 'paid' }, confidence: 0.95
  });

  const resolved = await store.resolveFact('order:42', 'status');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.value, 'paid');
  assert.equal(resolved.claims.length, 2);
  assert.ok((resolved.confidence ?? 0) > 0.98);
});

test('stage6 preserves conflicting observations instead of silently overwriting them', async (t) => {
  const store = new WorldModelStore(await tempDir(t));
  await store.observe({
    entity: { key: 'service:api', type: 'service', scopeKey: 'project:shop', label: 'API' },
    source: 'browser.health', domain: 'browser', evidenceDigest: 'c'.repeat(64),
    facts: { health: 'down' }, confidence: 0.8
  });
  await store.observe({
    entity: { key: 'service:api', type: 'service', scopeKey: 'project:shop', label: 'API' },
    source: 'docker.inspect', domain: 'process', evidenceDigest: 'd'.repeat(64),
    facts: { health: 'up' }, confidence: 0.8
  });
  const resolved = await store.resolveFact('service:api', 'health');
  assert.equal(resolved.status, 'conflict');
  assert.equal(resolved.claims.length, 2);
});

test('stage6 traces semantic relationships across browser, project and database entities', async (t) => {
  const store = new WorldModelStore(await tempDir(t));
  await store.observe({
    entity: { key: 'page:checkout', type: 'browser-page', scopeKey: 'project:shop', label: 'Checkout' },
    source: 'browser.inspect', domain: 'browser', evidenceDigest: 'e'.repeat(64),
    relations: [{ type: 'implemented-by', toKey: 'component:checkout', confidence: 0.9 }]
  });
  await store.observe({
    entity: { key: 'component:checkout', type: 'component', scopeKey: 'project:shop', label: 'Checkout component' },
    source: 'project.inspect', domain: 'project', evidenceDigest: 'f'.repeat(64),
    relations: [{ type: 'calls', toKey: 'service:orders', confidence: 0.9 }]
  });
  await store.observe({
    entity: { key: 'service:orders', type: 'service', scopeKey: 'project:shop', label: 'Orders service' },
    source: 'project.inspect', domain: 'project', evidenceDigest: '1'.repeat(64),
    relations: [{ type: 'persists-to', toKey: 'table:orders', confidence: 0.95 }]
  });
  await store.observe({
    entity: { key: 'table:orders', type: 'database-table', scopeKey: 'project:shop', label: 'orders' },
    source: 'postgres.inspect', domain: 'database', evidenceDigest: '2'.repeat(64)
  });

  const pathResult = await store.trace({ fromKey: 'page:checkout', targetType: 'database-table' });
  assert.deepEqual(pathResult?.entityKeys, ['page:checkout', 'component:checkout', 'service:orders', 'table:orders']);
  assert.deepEqual(pathResult?.relations.map((item) => item.type), ['implemented-by', 'calls', 'persists-to']);
});

test('stage6 refuses secret-bearing fact keys', async (t) => {
  const store = new WorldModelStore(await tempDir(t));
  await assert.rejects(
    store.observe({
      entity: { key: 'service:x', type: 'service', scopeKey: 'project:x', label: 'x' },
      source: 'application', domain: 'application', evidenceDigest: '3'.repeat(64),
      facts: { apiToken: 'must-not-persist' }
    }),
    (error: any) => error?.code === 'WORLD_SECRET_FACT_DENIED'
  );
  await assert.rejects(fs.access(path.join(await tempDir(t), 'world-model.json'))).catch(() => undefined);
});

test('stage6 entity identity cannot be reinterpreted under a different scope/type', async (t) => {
  const store = new WorldModelStore(await tempDir(t));
  await store.observe({
    entity: { key: 'repo:alpha', type: 'repository', scopeKey: 'org:a', label: 'alpha' },
    source: 'git', domain: 'git', evidenceDigest: '4'.repeat(64)
  });
  await assert.rejects(
    store.observe({
      entity: { key: 'repo:alpha', type: 'database', scopeKey: 'org:b', label: 'forged' },
      source: 'other', domain: 'other', evidenceDigest: '5'.repeat(64)
    }),
    (error: any) => error?.code === 'WORLD_ENTITY_IDENTITY_CONFLICT'
  );
});


test('stage6 rejects secret-bearing nested world values and obvious credential strings', async (t) => {
  const store = new WorldModelStore(await tempDir(t));
  await assert.rejects(
    store.observe({
      entity: { key: 'service:nested-secret', type: 'service', scopeKey: 'project:x', label: 'Nested secret' },
      source: 'verifier', domain: 'application', evidenceDigest: '6'.repeat(64),
      facts: { config: { endpoint: 'https://example.invalid', token: 'must-not-persist' } }
    }),
    (error: any) => error?.code === 'WORLD_SECRET_FACT_DENIED'
  );
  await assert.rejects(
    store.observe({
      entity: { key: 'service:bearer-secret', type: 'service', scopeKey: 'project:x', label: 'Bearer secret' },
      source: 'verifier', domain: 'application', evidenceDigest: '7'.repeat(64),
      facts: { statusText: 'Bearer abcdefghijklmnopqrstuvwxyz123456' }
    }),
    (error: any) => error?.code === 'WORLD_SECRET_FACT_DENIED'
  );
});


test('stage6 expired unreferenced entity shells are reclaimed before new entity admission', async (t) => {
  let nowMs = Date.parse('2026-10-01T00:00:00.000Z');
  const clock = () => new Date(nowMs);
  const store = new WorldModelStore(await tempDir(t), { clock, maxEntities: 3 });

  for (let index = 0; index < 3; index += 1) {
    await store.observe({
      entity: { key: `ephemeral:${index}`, type: 'ephemeral', scopeKey: 'scope:test', label: `Ephemeral ${index}` },
      source: 'test', domain: 'other', evidenceDigest: String(index + 1).repeat(64),
      facts: { state: 'present' }, ttlMs: 5_000
    });
  }
  assert.equal((await store.listEntities({ limit: 10 })).length, 3);

  nowMs += 5_001;
  await store.observe({
    entity: { key: 'ephemeral:new', type: 'ephemeral', scopeKey: 'scope:test', label: 'New' },
    source: 'test', domain: 'other', evidenceDigest: 'a'.repeat(64),
    facts: { state: 'fresh' }, ttlMs: 5_000
  });
  const entities = await store.listEntities({ limit: 10 });
  assert.deepEqual(entities.map((entity) => entity.key), ['ephemeral:new']);
});


test('stage6 empty entities remain while referenced by a live relation', async (t) => {
  let nowMs = Date.parse('2026-10-01T10:00:00.000Z');
  const clock = () => new Date(nowMs);
  const store = new WorldModelStore(await tempDir(t), { clock });

  await store.observe({
    entity: { key: 'node:b', type: 'node', scopeKey: 'scope:test', label: 'B' },
    source: 'test', domain: 'other', evidenceDigest: 'b'.repeat(64)
  });
  await store.observe({
    entity: { key: 'node:a', type: 'node', scopeKey: 'scope:test', label: 'A' },
    source: 'test', domain: 'other', evidenceDigest: 'c'.repeat(64),
    facts: { transient: true }, ttlMs: 5_000
  });
  await store.observe({
    entity: { key: 'node:a', type: 'node', scopeKey: 'scope:test', label: 'A' },
    source: 'relation-test', domain: 'other', evidenceDigest: 'd'.repeat(64),
    relations: [{ type: 'links-to', toKey: 'node:b' }], ttlMs: 10_000
  });

  nowMs += 5_001;
  await store.observe({
    entity: { key: 'node:c', type: 'node', scopeKey: 'scope:test', label: 'C' },
    source: 'test', domain: 'other', evidenceDigest: 'e'.repeat(64),
    facts: { state: 'fresh' }, ttlMs: 5_000
  });

  const keys = (await store.listEntities({ limit: 10 })).map((entity) => entity.key).sort();
  assert.deepEqual(keys, ['node:a', 'node:b', 'node:c']);
});
