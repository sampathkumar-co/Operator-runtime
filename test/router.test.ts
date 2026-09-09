import assert from 'node:assert/strict';
import test from 'node:test';
import { CapabilityRouter } from '../src/core/router.ts';
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
