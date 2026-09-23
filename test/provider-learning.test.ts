import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProviderLearningStore, learnedAdjustment } from '../src/core/provider-learning.ts';
import { CapabilityRouter } from '../src/core/router.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import type { ActionRequest, CapabilityProvider, CapabilityScore } from '../src/core/types.ts';

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return await fs.realpath(dir);
}

function provider(name: string, quality: number, calls?: { count: number }): CapabilityProvider {
  const score: CapabilityScore = {
    reliability: quality, latency: 1 - quality, determinism: quality,
    security: quality, reversibility: quality, informationQuality: quality,
    interactionCost: 1 - quality
  };
  return {
    name,
    supports: (action) => action.capability === 'file.read',
    score: () => score,
    execute: async (action) => {
      if (calls) calls.count += 1;
      return { ok: true, capability: action.capability, provider: name, evidence: [], durationMs: 0 };
    }
  };
}

const action: ActionRequest = {
  id: 'learning-route', capability: 'file.read', risk: 'read',
  input: { path: 'secret-project/customer.txt' }, provenance: { kind: 'trusted_policy' }
};

test('learned provider adjustment is bounded and requires repeated evidence', () => {
  assert.equal(learnedAdjustment(0, 0), 0);
  assert.equal(learnedAdjustment(1, 0), 0);
  assert.ok(learnedAdjustment(20, 0) > 0);
  assert.ok(learnedAdjustment(0, 20) < 0);
  assert.ok(learnedAdjustment(1000, 0) <= 0.06);
  assert.ok(learnedAdjustment(0, 1000) >= -0.06);
  assert.ok(learnedAdjustment(20, 0, 25, 20) > learnedAdjustment(20, 0, 10_000, 20));
});

test('verified local outcomes can change ranking only among already-supported providers', async (t) => {
  const state = await tempDir(t, 'operator-learning-route-');
  const learning = new ProviderLearningStore(state);
  const router = new CapabilityRouter({ learning });
  router.register(provider('static-a', 0.80));
  router.register(provider('adaptive-b', 0.78));

  assert.equal((await router.select(action)).name, 'static-a');
  for (let i = 0; i < 20; i += 1) await router.recordOutcome('file.read', 'adaptive-b', 'verified');
  assert.equal((await router.select(action)).name, 'adaptive-b');
  assert.equal(await router.recordOutcome('file.read', 'not-registered', 'verified'), false);
});

test('learning is contextual and observed latency can break otherwise-equal routing ties', async (t) => {
  const state = await tempDir(t, 'operator-learning-context-');
  const learning = new ProviderLearningStore(state);
  const router = new CapabilityRouter({ learning });
  router.register(provider('fast-context', 0.80));
  router.register(provider('slow-context', 0.80));

  for (let i = 0; i < 20; i += 1) {
    await router.recordOutcome('file.read', 'fast-context', 'verified', { context: 'browser-navigation', durationMs: 25 });
    await router.recordOutcome('file.read', 'slow-context', 'verified', { context: 'browser-navigation', durationMs: 10_000 });
  }

  assert.equal((await router.select(action, 'browser-navigation')).name, 'fast-context');
  assert.equal((await router.select(action, 'global')).name, 'fast-context');
  assert.equal(await learning.adjustment('file.read', 'fast-context', 'docker-lifecycle'), 0);
});

test('version-1 learning state migrates without losing bounded reliability history', async (t) => {
  const state = await tempDir(t, 'operator-learning-v1-migrate-');
  await fs.writeFile(path.join(state, 'provider-learning.json'), JSON.stringify({
    version: 1,
    entries: [{
      capability: 'file.read', provider: 'legacy-provider', verified: 20, failed: 0,
      updatedAt: new Date(0).toISOString()
    }]
  }));
  const learning = new ProviderLearningStore(state);
  assert.ok(await learning.adjustment('file.read', 'legacy-provider', 'global') > 0);
  await learning.record('file.read', 'legacy-provider', 'verified', { context: 'global', durationMs: 50 });
  const migrated = JSON.parse(await fs.readFile(path.join(state, 'provider-learning.json'), 'utf8'));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.entries[0].context, 'global');
  assert.equal(migrated.entries[0].verified, 21);
  assert.equal(migrated.entries[0].latencySamples, 1);
});

test('learning state persists only bounded capability/provider counters, never task inputs', async (t) => {
  const state = await tempDir(t, 'operator-learning-privacy-');
  const learning = new ProviderLearningStore(state);
  await learning.record('file.read', 'filesystem.native', 'verified');
  await learning.record('file.read', 'filesystem.native', 'failed');
  const persisted = await fs.readFile(path.join(state, 'provider-learning.json'), 'utf8');
  const decoded = JSON.parse(persisted);
  assert.equal(decoded.version, 2);
  assert.deepEqual(Object.keys(decoded.entries[0]).sort(), [
    'capability', 'context', 'failed', 'latencyEwmaMs', 'latencySamples', 'provider', 'updatedAt', 'verified'
  ]);
  assert.doesNotMatch(persisted, /secret-project|customer\.txt|learning-route/);
});

test('malformed structured learning state is classified as corrupt rather than caller input', async (t) => {
  const state = await tempDir(t, 'operator-learning-structured-corrupt-');
  await fs.writeFile(path.join(state, 'provider-learning.json'), JSON.stringify({
    version: 2,
    entries: [{
      capability: 'file.read\nforged',
      provider: 'native',
      context: 'global',
      verified: 1,
      failed: 0,
      latencyEwmaMs: 0,
      latencySamples: 0,
      updatedAt: new Date(0).toISOString()
    }]
  }));
  const learning = new ProviderLearningStore(state);
  await assert.rejects(
    () => learning.adjustment('file.read', 'native', 'global'),
    (error: any) => error?.code === 'PROVIDER_LEARNING_STATE_CORRUPT'
  );
});

test('corrupt learning state fails routing closed before any provider executes', async (t) => {
  const state = await tempDir(t, 'operator-learning-corrupt-');
  await fs.writeFile(path.join(state, 'provider-learning.json'), '{not-json', { mode: 0o600 });
  const calls = { count: 0 };
  const runtime = new OperatorRuntime({ learning: new ProviderLearningStore(state) }).register(provider('native', 0.9, calls));
  const result = await runtime.execute(action, { allowedCapabilities: ['file.read'], allowedRoots: [] });
  assert.equal(result.ok, false);
  assert.equal(result.provider, 'router');
  assert.equal(result.error?.code, 'PROVIDER_LEARNING_STATE_CORRUPT');
  assert.equal(calls.count, 0);
});

test('learning state refuses symbolic-link substitution', async (t) => {
  const state = await tempDir(t, 'operator-learning-link-');
  const outside = await tempDir(t, 'operator-learning-link-outside-');
  const sentinel = path.join(outside, 'sentinel.json');
  await fs.writeFile(sentinel, JSON.stringify({ version: 1, entries: [] }));
  try {
    await fs.symlink(sentinel, path.join(state, 'provider-learning.json'), 'file');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') { t.skip(`symlink unavailable (${code})`); return; }
    throw error;
  }
  const learning = new ProviderLearningStore(state);
  await assert.rejects(() => learning.adjustment('file.read', 'native'), (error: any) => error?.code === 'PROVIDER_LEARNING_STATE_CORRUPT');
  assert.equal(await fs.readFile(sentinel, 'utf8'), JSON.stringify({ version: 1, entries: [] }));
});
