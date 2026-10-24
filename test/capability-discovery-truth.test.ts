import assert from 'node:assert/strict';
import test from 'node:test';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { discoverBuiltInCapabilities } from '../src/core/capability-discovery.ts';
import type { ActionRequest, CapabilityProvider } from '../src/core/types.ts';

function fixture(name = 'synthetic-contract-provider'): { provider: CapabilityProvider; calls: { executed: number } } {
  const calls = { executed: 0 };
  const provider: CapabilityProvider = {
    name,
    supports: (a: ActionRequest) => {
      if (a.capability === 'browser.inspect') throw new Error('synthetic probe unavailable');
      return ['git.status', 'file.manage', 'file.create'].includes(a.capability);
    },
    advertises: a => a.capability !== 'file.create',
    score: () => ({ reliability: 1, latency: 0, determinism: 1, security: 1,
      reversibility: 1, informationQuality: 1, interactionCost: 0 }),
    execute: async () => {
      calls.executed++;
      throw new Error('discovery must never dispatch');
    }
  };
  return { provider, calls };
}

test('C02 runtime exposes all built-in canonical risks with truthful unexecuted provider claims', async () => {
  const { provider, calls } = fixture();
  const runtime = new OperatorRuntime().register(provider);
  const snapshot = await runtime.inspectCapabilityDeclarations();
  assert.ok(snapshot.capabilities.length >= 50);
  assert.equal(snapshot.registeredProviders, 1);
  assert.equal(snapshot.provenance, 'CURRENT_REGISTERED_PROVIDER_DECLARATIONS');
  const git = snapshot.capabilities.find(c => c.capability === 'git.status')!;
  assert.equal(git.status, 'DECLARED_NOT_EXECUTED');
  assert.equal(git.canonicalRisk, 'read');
  assert.deepEqual(git.providerNames, ['synthetic-contract-provider']);
  assert.equal(git.authorizationStatus, 'NOT_CHECKED');
  assert.equal(git.operationalStatus, 'NOT_TESTED');
  assert.equal(git.outputVerificationStatus, 'NOT_TESTED');
  assert.equal(calls.executed, 0);
});
test('C02 a dynamic capability declaration cannot become a read-only authorization', async () => {
  const r = await discoverBuiltInCapabilities([fixture().provider]);
  const mutable = r.capabilities.find(c => c.capability === 'file.manage')!;
  assert.equal(mutable.canonicalRisk, 'dynamic');
  assert.equal(mutable.dynamicRiskStatus, 'REQUIRES_TYPED_INPUT_AND_FRESH_AUTHORIZATION');
  assert.equal(mutable.mayRequireTypedInput, true);
  assert.equal(r.sourceTruth, 'NOT_AN_EXECUTION_OR_AUTHORITY_GRANT');
});
test('C02 false advertisement and a throwing optional provider never become false operational success', async () => {
  const r = await discoverBuiltInCapabilities([fixture().provider]);
  const suppressed = r.capabilities.find(c => c.capability === 'file.create')!;
  assert.equal(suppressed.status, 'NOT_ADVERTISED_WITH_EMPTY_INPUT');
  const browser = r.capabilities.find(c => c.capability === 'browser.inspect')!;
  assert.equal(browser.status, 'PROBE_INDETERMINATE');
  assert.equal(browser.providerNames.length, 0);
  assert.equal(browser.operationalStatus, 'NOT_TESTED');
});
test('C02 ambiguous/duplicated provider registration is rejected rather than silently merged', async () => {
  const first = fixture().provider, second = fixture().provider;
  await assert.rejects(discoverBuiltInCapabilities([first, second]), /INVALID_PROVIDER_REGISTRY/);
});
