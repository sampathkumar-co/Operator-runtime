import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { CAPABILITY_RISK_RULES } from '../src/core/capability-policy.ts';
import type { ActionRequest, CapabilityProvider } from '../src/core/types.ts';

const CANONICAL = Object.entries(CAPABILITY_RISK_RULES).sort(([a], [b]) => a.localeCompare(b));
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error('WAVE0_PROVIDER_CENSUS_INVALID: ' + message);
}
export async function buildWave0ProviderCensus(providers: readonly CapabilityProvider[], sourceCommit: string, platform: string) {
  check(/^[a-f0-9]{40}$/.test(sourceCommit), 'source identity must be immutable full Git SHA');
  check(providers.length > 0, 'no runtime providers');
  const names = providers.map(p => p.name);
  check(names.every(n => typeof n === 'string' && n.length > 0), 'provider name missing');
  check(new Set(names).size === names.length, 'duplicate provider name');
  check(CANONICAL.length >= 50, 'unexpectedly smaller canonical risk registry');

  const coverage = [];
  const providerEntries = [];
  const unsupported = new Set(CANONICAL.map(([capability]) => capability));
  for (const provider of providers) {
    const supported = [];
    const unresolved = [];
    for (const [capability, risk] of CANONICAL) {
      const action: ActionRequest = {
        id: 'wave0-census-' + capability, capability, risk: risk === 'dynamic' ? 'read' : risk,
        input: {}, provenance: { kind: 'runtime' }
      };
      try {
        if (await provider.supports(action)) {
          unsupported.delete(capability);
          supported.push({
            capability, canonicalRisk: risk,
            runtimeAvailability: 'NOT_PROBED',
            executionAuthorization: 'NOT_TESTED',
            verification: 'NOT_TESTED',
            platformCertification: 'NOT_TESTED',
            ...(risk === 'dynamic' ? { dynamicActionRisk: 'REQUIRES_TYPED_INPUT_AND_PROVIDER_RESOLUTION' } : {})
          });
        }
      } catch (error) {
        unresolved.push({ capability, risk,
          state: 'EMPTY_INPUT_PROBE_UNRESOLVED',
          errorCode: error instanceof Error ? error.name : 'UNKNOWN' });
      }
    }
    coverage.push(...supported.map(item => ({ provider: provider.name, capability: item.capability, risk: item.canonicalRisk })));
    providerEntries.push({ name: provider.name, class: provider.constructor.name,
      emptyInputDeclaredSupports: supported, unresolvedEmptyInputProbes: unresolved });
  }
  return {
    schemaVersion: 1, sourceCommit, observedPlatform: platform,
    declaredBuiltInRiskCount: CANONICAL.length,
    runtimeRegisteredProviderCount: providers.length,
    providers: providerEntries,
    canonicalCapabilitiesWithoutPositiveEmptyInputSupport: [...unsupported].sort(),
    positiveProbePairs: coverage.length,
    method: 'Provider.supports(action) against all canonical capabilities with intentionally empty input; NO provider.execute, network/model/authority/physical tests',
    boundaries: [
      'A false support probe with empty input may require valid typed inputs; this is not proof that a capability is absent.',
      'A true supports() result is a declaration only, not proof of availability, policy authorization, working interactions, OS compatibility or postcondition verification.',
      'Optional providers, extensions and configured runtime profiles not registered in this minimal factory are not certified.',
      'The observed platform is the CI census environment, not a certified operating-system support matrix.'
    ]
  };
}
export async function censusCurrentGitCheckout() {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().toLowerCase();
  const runtime = createRuntime({ allowedRoots: [process.cwd()], allowedExecutables: [] });
  try {
    return await buildWave0ProviderCensus(runtime.router.providers(), sourceCommit, process.platform);
  } finally {
    await runtime.close();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const result = await censusCurrentGitCheckout();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
