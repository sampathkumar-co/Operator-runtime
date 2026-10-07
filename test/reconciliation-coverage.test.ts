import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { MUTATION_RECONCILIATION_POLICIES, assertCanonicalMutationPolicies } from '../src/core/reconciliation-coverage.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../src/core/types.ts';

const SCORE: CapabilityScore = {
  reliability: 1, latency: 0, determinism: 1, security: 1,
  reversibility: 1, informationQuality: 1, interactionCost: 0
};

test('every canonical mutable capability has an explicit reconciliation policy', () => {
  assert.doesNotThrow(assertCanonicalMutationPolicies);
  assert.equal(MUTATION_RECONCILIATION_POLICIES['compute.run']?.mode, 'side_effect_free');
});

test('production runtime providers satisfy mutable reconciliation contracts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-reconciliation-coverage-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const runtime = createRuntime({ allowedRoots: [root], allowedExecutables: [] });
  t.after(async () => runtime.close());
  await assert.doesNotReject(() => runtime.assertMutationReconciliationCoverage());
});

test('coverage fails closed when a mutable provider lacks reconciliation', async () => {
  const provider: CapabilityProvider = {
    name: 'broken-browser',
    supports: (action) => action.capability === 'browser.navigate',
    score: () => SCORE,
    execute: async (action: ActionRequest): Promise<ActionResult> => ({
      ok: true, capability: action.capability, provider: 'broken-browser', evidence: [], durationMs: 0
    })
  };
  const runtime = new OperatorRuntime().register(provider);
  await assert.rejects(() => runtime.assertMutationReconciliationCoverage(), (error: unknown) => (
    error instanceof Error && error.message.includes('without a reconciliation contract')
  ));
});

test('side-effect-free compute has deterministic reconciliation without a provider hook', async () => {
  const provider: CapabilityProvider = {
    name: 'isolated-compute-test',
    supports: (action) => action.capability === 'compute.run',
    score: () => SCORE,
    execute: async (action: ActionRequest): Promise<ActionResult> => ({
      ok: true, capability: action.capability, provider: 'isolated-compute-test', evidence: [], durationMs: 0
    })
  };
  const runtime = new OperatorRuntime().register(provider);
  await assert.doesNotReject(() => runtime.assertMutationReconciliationCoverage());
  const result = await runtime.reconcile({
    id: 'compute-reconcile', capability: 'compute.run', risk: 'write', input: {}, provenance: { kind: 'runtime' }
  }, provider.name, {
    ok: false, capability: 'compute.run', provider: provider.name, evidence: [],
    error: { code: 'COMPUTE_FAILED', message: 'not dispatched', sideEffectState: 'none' }, durationMs: 0
  });
  assert.equal(result.status, 'not_applied');
});
