import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWave0ProviderCensus, censusCurrentGitCheckout } from '../scripts/wave0-provider-census.ts';
import type { ActionRequest, CapabilityProvider } from '../src/core/types.ts';
const sourceCommit = 'a'.repeat(40);

function mockProvider(name: string, onExecute?: () => never): CapabilityProvider {
  return {
    name,
    supports: (action: ActionRequest) => {
      if (action.capability === 'project.command.run') throw new TypeError('typed input required');
      return ['git.status', 'file.manage'].includes(action.capability);
    },
    score: () => ({ reliability: 1, latency: 1, determinism: 1, security: 1,
      reversibility: 1, informationQuality: 1, interactionCost: 1 }),
    execute: async () => {
      onExecute?.();
      throw new Error('must not execute');
    }
  };
}
test('C00 provider risk census reports positive claims without executing or certifying them', async () => {
  let executed = false;
  const provider = mockProvider('synthetic.fixture', () => {
    executed = true;
    throw new Error('unexpected dispatch');
  });
  const report = await buildWave0ProviderCensus([provider], sourceCommit, 'linux');
  assert.equal(executed, false);
  assert.equal(report.positiveProbePairs, 2);
  assert.equal(report.runtimeRegisteredProviderCount, 1);
  assert.equal(report.providers[0].unresolvedEmptyInputProbes[0].capability, 'project.command.run');
  const status = report.providers[0].emptyInputDeclaredSupports.find(c => c.capability === 'git.status');
  assert.equal(status?.canonicalRisk, 'read');
  assert.equal(status?.executionAuthorization, 'NOT_TESTED');
  const file = report.providers[0].emptyInputDeclaredSupports.find(c => c.capability === 'file.manage');
  assert.equal(file?.dynamicActionRisk, 'REQUIRES_TYPED_INPUT_AND_PROVIDER_RESOLUTION');
});
test('C00 census rejects reused provider identity and mutable source references', async () => {
  const provider = mockProvider('same.identity');
  await assert.rejects(buildWave0ProviderCensus([provider, provider], sourceCommit, 'linux'), /duplicate provider name/);
  await assert.rejects(buildWave0ProviderCensus([provider], 'main', 'linux'), /immutable full Git SHA/);
});
test('C00 real runtime registration produces an honest non-execution source census', async () => {
  const report = await censusCurrentGitCheckout();
  assert.match(report.sourceCommit, /^[0-9a-f]{40}$/);
  assert.ok(report.runtimeRegisteredProviderCount >= 15);
  assert.equal(report.declaredBuiltInRiskCount, 55);
  assert.equal(report.providers.length, report.runtimeRegisteredProviderCount);
  assert.equal(report.providers.every(p => p.emptyInputDeclaredSupports.every(op =>
    op.verification === 'NOT_TESTED' && op.platformCertification === 'NOT_TESTED')), true);
});
