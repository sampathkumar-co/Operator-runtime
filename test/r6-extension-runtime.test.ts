import assert from 'node:assert/strict';
import test from 'node:test';
import { CapabilityExtensionRegistry } from '../src/core/capability-sdk.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';

const manifest = {
  sdkVersion: 1 as const,
  id: 'acme.ops',
  version: '1.0.0',
  displayName: 'Acme Ops',
  provenance: { source: 'https://example.invalid/acme', packageDigest: 'a'.repeat(64) },
  capabilities: [{
    capability: 'ext.acme.ops.record.write',
    risk: 'write' as const,
    deterministic: true,
    reversible: true,
    verification: 'provider' as const,
    reconciliation: 'provider' as const,
    inputSchemaVersion: 1 as const,
    inputMaxBytes: 4096,
    outputMaxBytes: 4096,
    cancellation: 'required' as const,
    resourceKinds: ['record']
  }]
};
const provider = {
  name: 'acme-provider',
  supports: (action: any) => action.capability === 'ext.acme.ops.record.write',
  score: () => ({ reliability: 1, latency: 1, determinism: 1, security: 1, reversibility: 1, informationQuality: 1, interactionCost: 1 }),
  execute: async (action: any) => ({ ok: true, capability: action.capability, provider: 'acme-provider', output: { written: true }, evidence: [], durationMs: 1 }),
  reconcile: async () => ({ status: 'not_applied' as const, evidence: [] })
};

test('third-party namespace adds a capability without a core risk-table edit', async () => {
  const registry = new CapabilityExtensionRegistry();
  const runtime = new OperatorRuntime();
  runtime.register(registry.register(manifest, provider as any));
  const result = await runtime.execute({
    id: 'r6-custom-1',
    capability: 'ext.acme.ops.record.write',
    risk: 'write',
    input: { id: '1' },
    provenance: { kind: 'chatgpt' }
  }, {
    allowedCapabilities: ['ext.acme.ops.*'],
    allowedRoots: [],
    maxRisk: 'write'
  });
  assert.equal(result.ok, true);
  assert.match(result.provider, /^extension:acme\.ops:/);
});

test('third-party capability cannot under-declare its certified risk', async () => {
  const registry = new CapabilityExtensionRegistry();
  const runtime = new OperatorRuntime();
  runtime.register(registry.register(manifest, provider as any));
  const result = await runtime.execute({
    id: 'r6-custom-2',
    capability: 'ext.acme.ops.record.write',
    risk: 'read',
    input: {},
    provenance: { kind: 'chatgpt' }
  }, {
    allowedCapabilities: ['ext.acme.ops.*'],
    allowedRoots: [],
    maxRisk: 'write'
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'ACTION_RISK_MISMATCH');
});

test('unnamespaced new capability is rejected at manifest validation', () => {
  const registry = new CapabilityExtensionRegistry();
  assert.throws(() => registry.register({
    ...manifest,
    capabilities: [{ ...manifest.capabilities[0], capability: 'record.write' }]
  }, provider as any), (error: any) => error?.code === 'CAPABILITY_MANIFEST_NAMESPACE_INVALID');
});
