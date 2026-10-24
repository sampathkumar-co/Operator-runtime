import { CAPABILITY_RISK_RULES, type CapabilityRiskRule } from './capability-policy.ts';
import type { ActionRequest, CapabilityProvider } from './types.ts';

export type CapabilityProbeStatus =
  | 'DECLARED_NOT_EXECUTED'
  | 'NOT_ADVERTISED_WITH_EMPTY_INPUT'
  | 'PROBE_INDETERMINATE';

export interface CapabilityDiscoveryEntry {
  capability: string;
  canonicalRisk: CapabilityRiskRule;
  status: CapabilityProbeStatus;
  providerNames: string[];
  mayRequireTypedInput: boolean;
  authorizationStatus: 'NOT_CHECKED';
  operationalStatus: 'NOT_TESTED';
  outputVerificationStatus: 'NOT_TESTED';
  dynamicRiskStatus?: 'REQUIRES_TYPED_INPUT_AND_FRESH_AUTHORIZATION';
}

export interface CapabilityDiscoverySnapshot {
  schemaVersion: 1;
  provenance: 'CURRENT_REGISTERED_PROVIDER_DECLARATIONS';
  probeMode: 'BOUNDED_EMPTY_INPUT_NO_DISPATCH';
  registeredProviders: number;
  capabilities: CapabilityDiscoveryEntry[];
  sourceTruth: 'NOT_AN_EXECUTION_OR_AUTHORITY_GRANT';
}

/**
 * Model-neutral discovery is not permission negotiation.
 * supports and advertises are called without dispatch and with empty inputs.
 * False results may require typed operation arguments; exceptions become
 * INDETERMINATE rather than manufacturing absence or authorization.
 */
export async function discoverBuiltInCapabilities(
  providers: readonly CapabilityProvider[]
): Promise<CapabilityDiscoverySnapshot> {
  const names = providers.map(provider => provider.name);
  if (names.some(n => !n || typeof n !== 'string' || n.length > 256)
      || new Set(names).size !== names.length) {
    throw new Error('CAPABILITY_DISCOVERY_INVALID_PROVIDER_REGISTRY');
  }
  const entries: CapabilityDiscoveryEntry[] = [];
  for (const [capability, canonicalRisk] of Object.entries(CAPABILITY_RISK_RULES).sort(([a], [b]) => a.localeCompare(b))) {
    const action: ActionRequest = {
      id: 'discovery:' + capability,
      capability,
      risk: canonicalRisk === 'dynamic' ? 'read' : canonicalRisk,
      input: {}, provenance: { kind: 'runtime' }
    };
    const providersAdvertising: string[] = [];
    let indeterminate = false;
    for (const provider of providers) {
      try {
        if (!await provider.supports(action)) continue;
        if (provider.advertises && !await provider.advertises(action)) continue;
        providersAdvertising.push(provider.name);
      } catch {
        indeterminate = true;
      }
    }
    const status: CapabilityProbeStatus = indeterminate ? 'PROBE_INDETERMINATE'
      : providersAdvertising.length > 0 ? 'DECLARED_NOT_EXECUTED'
      : 'NOT_ADVERTISED_WITH_EMPTY_INPUT';
    entries.push({
      capability, canonicalRisk, status,
      providerNames: [...providersAdvertising].sort(),
      mayRequireTypedInput: status !== 'DECLARED_NOT_EXECUTED' || canonicalRisk === 'dynamic',
      authorizationStatus: 'NOT_CHECKED', operationalStatus: 'NOT_TESTED',
      outputVerificationStatus: 'NOT_TESTED',
      ...(canonicalRisk === 'dynamic' ? { dynamicRiskStatus: 'REQUIRES_TYPED_INPUT_AND_FRESH_AUTHORIZATION' as const } : {})
    });
  }
  return {
    schemaVersion: 1, provenance: 'CURRENT_REGISTERED_PROVIDER_DECLARATIONS',
    probeMode: 'BOUNDED_EMPTY_INPUT_NO_DISPATCH',
    registeredProviders: providers.length,
    capabilities: entries,
    sourceTruth: 'NOT_AN_EXECUTION_OR_AUTHORITY_GRANT'
  };
}
