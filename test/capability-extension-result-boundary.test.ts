import assert from 'node:assert/strict';
import test from 'node:test';
import { CapabilityExtensionRegistry } from '../src/core/capability-sdk.ts';
import type {
  ActionRequest, ActionResult, CapabilityProvider, CapabilityScore, ProviderReconciliationResult
} from '../src/core/types.ts';

const action: ActionRequest = {
  id: 'extension-test-action', capability: 'file.write', risk: 'write',
  input: { content: 'synthetic' }, provenance: { kind: 'runtime' }
};
const score: CapabilityScore = {
  reliability: 1, latency: 1, determinism: 1, security: 1,
  reversibility: 1, informationQuality: 1, interactionCost: 0
};
const manifest = {
  sdkVersion: 1 as const, id: 'example.safe-write', version: '1.0.0',
  displayName: 'Test Write Provider',
  provenance: { source: 'synthetic:test', packageDigest: 'a'.repeat(64) },
  capabilities: [{
    capability: 'file.write', risk: 'write' as const,
    deterministic: true, reversible: true, verification: 'runtime' as const,
    reconciliation: 'provider' as const, inputSchemaVersion: 1 as const,
    inputMaxBytes: 1024, outputMaxBytes: 1024,
    cancellation: 'required' as const, resourceKinds: ['file']
  }]
};
const validResult = (): ActionResult => ({
  ok: true, capability: action.capability, provider: 'synthetic',
  output: { saved: true }, evidence: [], durationMs: 1
});
function wrapper(
  executeResult: unknown = validResult(),
  reconciliationResult: unknown = { status: 'completed', evidence: [], result: validResult() }
) {
  const provider: CapabilityProvider = {
    name: 'synthetic', supports: () => true, score: () => score,
    execute: async () => executeResult as ActionResult,
    reconcile: async () => reconciliationResult as ProviderReconciliationResult
  };
  return new CapabilityExtensionRegistry().register(manifest, provider);
}

test('malformed extension execution returns classified uncertain mutation instead of crashing', async () => {
  for (const invalid of [null, 123, { durationMs: Number.NaN }]) {
    const result = await wrapper(invalid).execute(action);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'CAPABILITY_EXTENSION_RESULT_INVALID');
    assert.equal(result.error?.retryable, false);
    assert.equal(result.error?.sideEffectState, 'uncertain');
    assert.equal(result.durationMs, 0);
  }
});

test('reconciliation rejects results attributed to another capability or provider', async () => {
  for (const tamper of [{ capability: 'file.read' }, { provider: 'another-provider' }]) {
    const result = await assert.rejects(
      () => wrapper(validResult(), {
        status: 'completed', evidence: [], result: { ...validResult(), ...tamper }
      }).reconcile!({ action }),
      (error: any) => error?.code === 'CAPABILITY_EXTENSION_RECONCILIATION_INVALID'
    );
    assert.equal(result, undefined);
  }
});

test('reconciliation rejects malformed and over-limit results without claiming completion', async () => {
  for (const invalid of [{ ...validResult(), evidence: null }, {
    ...validResult(), output: { content: 'x'.repeat(2000) }
  }]) {
    await assert.rejects(
      () => wrapper(validResult(), { status: 'completed', evidence: [], result: invalid }).reconcile!({ action }),
      (error: any) => error?.code === 'CAPABILITY_EXTENSION_RECONCILIATION_INVALID'
    );
  }
});

test('valid reconciliation results retain their bounded extension provider identity', async () => {
  const wrapped = wrapper();
  const outcome = await wrapped.reconcile!({ action });
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.result?.capability, 'file.write');
  assert.equal(outcome.result?.provider, 'extension:example.safe-write:synthetic');
});

test('uncertain reconciliation without a result is retained as uncertainty', async () => {
  const wrapped = wrapper(validResult(), { status: 'uncertain', evidence: [] });
  const outcome = await wrapped.reconcile!({ action });
  assert.equal(outcome.status, 'uncertain');
  assert.equal(outcome.result, undefined);
});
