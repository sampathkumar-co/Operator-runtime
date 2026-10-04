import assert from 'node:assert/strict';
import test from 'node:test';
import { CapabilityExtensionRegistry, capabilityManifestDigest } from '../src/core/capability-sdk.ts';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../src/core/types.ts';

const score: CapabilityScore = { reliability: 1, latency: 1, determinism: 1, security: 1, reversibility: 1, informationQuality: 1, interactionCost: 0 };

class ExtensionProbe implements CapabilityProvider {
  readonly name = 'probe';
  calls = 0;
  supports(): boolean { return true; }
  score(): CapabilityScore { return score; }
  async execute(action: ActionRequest): Promise<ActionResult> {
    this.calls += 1;
    return { ok: true, capability: action.capability, provider: this.name, output: {}, evidence: [], durationMs: 1 };
  }
}

const manifest = {
  sdkVersion: 1 as const,
  id: 'example.files',
  version: '1.2.3',
  displayName: 'Example Files',
  provenance: { source: 'package:example.files', packageDigest: 'a'.repeat(64) },
  capabilities: [{
    capability: 'file.read',
    risk: 'read' as const,
    deterministic: true,
    reversible: true,
    verification: 'runtime' as const,
    reconciliation: 'not-required' as const,
    inputSchemaVersion: 1 as const,
    inputMaxBytes: 16 * 1024,
    outputMaxBytes: 16 * 1024,
    cancellation: 'required' as const,
    resourceKinds: ['file']
  }]
};

test('stage17 extension wrapper never exposes undeclared capabilities', async () => {
  const provider = new ExtensionProbe();
  const registry = new CapabilityExtensionRegistry();
  const wrapped = registry.register(manifest, provider);
  assert.equal(await wrapped.supports({
    id: 'a', capability: 'file.read', risk: 'read', input: {}, provenance: { kind: 'runtime' }
  }), true);
  assert.equal(await wrapped.supports({
    id: 'b', capability: 'file.write', risk: 'write', input: {}, provenance: { kind: 'runtime' }
  }), false);
  await assert.rejects(
    () => wrapped.execute({ id: 'b', capability: 'file.write', risk: 'write', input: {}, provenance: { kind: 'runtime' } }),
    (error: any) => error?.code === 'CAPABILITY_EXTENSION_SCOPE_DENIED'
  );
  assert.equal(provider.calls, 0);
});

test('stage17 manifest cannot relabel canonical capability risk', () => {
  const registry = new CapabilityExtensionRegistry();
  assert.throws(() => registry.register({
    ...manifest,
    id: 'example.bad',
    capabilities: [{ ...manifest.capabilities[0]!, risk: 'write' as const }]
  } as any, new ExtensionProbe()), (error: any) => error?.code === 'CAPABILITY_MANIFEST_RISK_MISMATCH');
});

test('stage17 manifest digest is stable and registry rejects duplicate identities', () => {
  const registry = new CapabilityExtensionRegistry();
  registry.register(manifest, new ExtensionProbe());
  assert.match(capabilityManifestDigest(manifest), /^[0-9a-f]{64}$/);
  assert.throws(() => registry.register(manifest, new ExtensionProbe()), (error: any) => error?.code === 'CAPABILITY_EXTENSION_DUPLICATE');
});


test('stage17 dynamic-risk capability fails closed without provider risk resolver', async () => {
  const registry = new CapabilityExtensionRegistry();
  const wrapped = registry.register({
    sdkVersion: 1,
    id: 'example.manage',
    version: '1.0.0',
    displayName: 'Example Manage',
    provenance: { source: 'package:example.manage', packageDigest: 'b'.repeat(64) },
    capabilities: [{
      capability: 'file.manage',
      risk: 'dynamic',
      deterministic: true,
      reversible: false,
      verification: 'runtime',
      reconciliation: 'provider',
      inputSchemaVersion: 1,
      inputMaxBytes: 16 * 1024,
      outputMaxBytes: 16 * 1024,
      cancellation: 'required',
      resourceKinds: ['file']
    }]
  }, Object.assign(new ExtensionProbe(), { reconcile: async () => ({ status: 'uncertain' as const, evidence: [] }) }));
  await assert.rejects(
    async () => await wrapped.resolveRisk?.({
      id: 'manage',
      capability: 'file.manage',
      risk: 'write',
      input: { operation: 'copy' },
      provenance: { kind: 'runtime' }
    }),
    (error: any) => error?.code === 'CAPABILITY_EXTENSION_DYNAMIC_RISK_UNRESOLVED'
  );
});

test('stage17 malformed mutable extensions fail before registration without reconciliation', () => {
  const registry = new CapabilityExtensionRegistry();
  assert.throws(() => registry.register({
    ...manifest,
    id: 'example.mutable',
    capabilities: [{
      ...manifest.capabilities[0]!, capability: 'file.write', risk: 'write', reconciliation: 'provider'
    }]
  }, new ExtensionProbe()), (error: any) => error?.code === 'CAPABILITY_EXTENSION_RECONCILIATION_REQUIRED');
  assert.deepEqual(registry.list(), []);
});

test('stage17 wrapper enforces declared input/output bounds and provider identity', async () => {
  class OversizedProbe extends ExtensionProbe {
    async execute(action: ActionRequest): Promise<ActionResult> {
      return { ok: true, capability: action.capability, provider: 'spoofed', output: { value: 'x'.repeat(20_000) }, evidence: [], durationMs: 1 };
    }
  }
  const wrapped = new CapabilityExtensionRegistry().register(manifest, new OversizedProbe());
  const result = await wrapped.execute({ id: 'bounded', capability: 'file.read', risk: 'read', input: {}, provenance: { kind: 'runtime' } });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'CAPABILITY_EXTENSION_RESULT_INVALID');
});
