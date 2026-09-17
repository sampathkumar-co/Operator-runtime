import assert from 'node:assert/strict';
import test from 'node:test';
import { CapabilityRouter } from '../src/core/router.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import type { CapabilityProvider } from '../src/core/types.ts';

function provider(name: string, reliability: number, latency: number): CapabilityProvider {
  return {
    name,
    supports: () => true,
    score: () => ({ reliability, latency, determinism: reliability, security: reliability, reversibility: reliability, informationQuality: reliability, interactionCost: latency }),
    execute: async (action) => ({ ok: true, capability: action.capability, provider: name, evidence: [], durationMs: 0 })
  };
}

test('router prefers stronger semantic capability by weighted quality', async () => {
  const router = new CapabilityRouter();
  router.register(provider('vision.mouse', 0.65, 0.8));
  router.register(provider('git.native', 0.99, 0.05));
  const selected = await router.select({ id: 'x', capability: 'git.status', risk: 'read', input: {}, provenance: { kind: 'chatgpt' } });
  assert.equal(selected.name, 'git.native');
});

test('runtime advertises only locally supported capabilities in stable order', async () => {
  const runtime = new OperatorRuntime();
  runtime.register({
    ...provider('local.dynamic', 0.9, 0.1),
    supports: (action) => ['file.read', 'git.status'].includes(action.capability)
  });
  const supported = await runtime.supportedCapabilities(['git.diff', 'file.read', 'git.status', 'file.read']);
  assert.deepEqual(supported, ['file.read', 'git.status']);
});

test('runtime keeps unavailable claimed capabilities routable while omitting them from advertisement', async () => {
  const runtime = new OperatorRuntime();
  runtime.register({
    ...provider('git.mock', 0.99, 0.05),
    supports: (action) => action.capability === 'git.status',
    advertises: () => false,
    execute: async (action) => ({
      ok: false,
      capability: action.capability,
      provider: 'git.mock',
      evidence: [],
      error: { code: 'GIT_VERSION_UNSUPPORTED', message: 'Git 2.45+ is required.', retryable: false },
      durationMs: 0
    })
  });

  assert.deepEqual(await runtime.supportedCapabilities(['git.status']), []);
  const result = await runtime.execute({
    id: 'git-version-error',
    capability: 'git.status',
    risk: 'read',
    input: {},
    provenance: { kind: 'runtime' }
  }, { allowedCapabilities: ['git.status'], allowedRoots: [] });
  assert.equal(result.ok, false);
  assert.equal(result.provider, 'git.mock');
  assert.equal(result.error?.code, 'GIT_VERSION_UNSUPPORTED');
});
