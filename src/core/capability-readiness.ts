import type { PermissionProfile } from './types.ts';
import type { CapabilityDiscoverySnapshot } from './capability-discovery.ts';
import { OperatorError } from './errors.ts';
import { CAPABILITY_RISK_RULES } from './capability-policy.ts';

const MAX_ITEMS = 128;
const CAPABILITY = /^[A-Za-z][A-Za-z0-9._:-]{0,255}$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RISKS = new Set(['read', 'write', 'external', 'system', 'destructive', 'dynamic']);
const MAX_ROOT_BYTES = 4096;
type Advertised =
  | 'PROVIDER_DECLARED_NOT_EXECUTION_TESTED'
  | 'SCOPE_NOT_LISTED'
  | 'ROOT_SCOPE_MISSING'
  | 'EMERGENCY_STOPPED'
  | 'REQUIRES_TYPED_INPUT'
  | 'PROVIDER_PROBE_INDETERMINATE'
  | 'NOT_ADVERTISED';
type NativeFamily = 'WINDOWS_UIA' | 'BROWSER_SESSION' | 'FILESYSTEM' | 'GENERAL';
export interface CapabilityReadinessEntry {
  capability: string;
  canonicalRisk: string;
  providerNames: string[];
  family: NativeFamily;
  state: Advertised;
  sourceOnly: true;
  requiresFreshAuthorization: true;
  currentPhysicalOperation: 'NOT_TESTED';
}
export interface ContextualCapabilityReadiness {
  schemaVersion: 1;
  source: 'CURRENT_PROVIDER_REGISTRY_AND_REQUEST_PERMISSION_PROFILE';
  snapshotKind: 'DECLARATIONS_NOT_EXECUTION';
  platform: 'win32' | 'linux' | 'darwin' | 'other';
  emergencyStopped: boolean;
  authorizedRootCount: number;
  capabilities: CapabilityReadinessEntry[];
  privacy: 'NO_TARGET_PATHS_OR_ACCOUNT_IDS';
  authority: 'NEVER_A_GRANT';
  deviceAndSessionReadiness: 'NOT_VERIFIED';
}
function invalid(reason: string): never {
  throw new OperatorError('CAPABILITY_READINESS_INVALID',reason);
}
function family(name: string): NativeFamily {
  if (/^(app\.|input\.operate$|visual\.capture$)/.test(name)) return 'WINDOWS_UIA';
  if (name.startsWith('browser.')) return 'BROWSER_SESSION';
  if (/^(file\.|project\.|workspace\.|git\.|vscode\.)/.test(name)) return 'FILESYSTEM';
  return 'GENERAL';
}
function listed(capability: string, allowed: readonly string[]): boolean {
  return allowed.some(grant => grant === capability || grant === '*' ||
    (grant.endsWith('.*') && grant.length > 2 &&
    capability.startsWith(grant.slice(0, -1))));
}
function safePlatform(value: unknown): ContextualCapabilityReadiness['platform'] {
  if(value === 'win32' || value === 'linux' || value === 'darwin') return value;
  return 'other';
}

/** 
 * Read-only current-source declarations adjusted for current request's
 * enterprise-filtered permission profile, Stop and configured roots.
 * Intentional limit: neither registered provider nor profile implies its
 * native helper, active browser tab, account, consent or device is available.
 * An actual action must STILL use the canonical authority & execution kernel.
 */
export function buildContextualCapabilityReadiness(input: {
  declaration: CapabilityDiscoverySnapshot;
  permissions: PermissionProfile;
  platform: string;
  emergencyStopped: boolean;
}): ContextualCapabilityReadiness {
  if (!input || typeof input !== 'object' ||
      input.declaration?.schemaVersion !== 1 ||
      input.declaration.provenance !== 'CURRENT_REGISTERED_PROVIDER_DECLARATIONS' ||
      input.declaration.sourceTruth !== 'NOT_AN_EXECUTION_OR_AUTHORITY_GRANT' ||
      input.declaration.probeMode !== 'BOUNDED_EMPTY_INPUT_NO_DISPATCH' ||
      !Number.isSafeInteger(input.declaration.registeredProviders) ||
      input.declaration.registeredProviders < 0 ||
      input.declaration.registeredProviders > MAX_ITEMS ||
      !Array.isArray(input.declaration.capabilities) ||
      input.declaration.capabilities.length > MAX_ITEMS ||
      !Array.isArray(input.permissions?.allowedCapabilities) ||
      !Array.isArray(input.permissions?.allowedRoots) ||
      input.permissions.allowedCapabilities.length > MAX_ITEMS ||
      input.permissions.allowedRoots.length > MAX_ITEMS ||
      input.permissions.allowedRoots.some(root => typeof root !== 'string' ||
        !root.trim() || root !== root.trim() || Buffer.byteLength(root, 'utf8') > MAX_ROOT_BYTES ||
        root.includes(String.fromCharCode(0))) ||
      typeof input.emergencyStopped !== 'boolean') {
    invalid('A bounded truthful current provider declaration and request authority profile are mandatory.');
  }
  const scope = input.permissions.allowedCapabilities;
  if(scope.some(x => typeof x !== 'string' || x.length > 256 ||
      (x !== '*' && !CAPABILITY.test(x) &&
        !(x.endsWith('.*') && CAPABILITY.test(x.slice(0,-1)+'x'))))) {
    invalid('Requested capability policy contains a malformed scope.');
  }
  const seen = new Set<string>();
  const capabilities: CapabilityReadinessEntry[] = [];
  for(const entry of input.declaration.capabilities) {
    if (!entry || typeof entry.capability !== 'string' ||
        !CAPABILITY.test(entry.capability) ||
        seen.has(entry.capability) ||
        !Array.isArray(entry.providerNames) ||
        entry.providerNames.length > MAX_ITEMS ||
        entry.providerNames.some(name=>typeof name !== 'string' || !PROVIDER.test(name)) ||
        new Set(entry.providerNames).size !== entry.providerNames.length ||
        !RISKS.has(entry.canonicalRisk) ||
        !Object.hasOwn(CAPABILITY_RISK_RULES, entry.capability) ||
        CAPABILITY_RISK_RULES[entry.capability] !== entry.canonicalRisk ||
        entry.providerNames.length > input.declaration.registeredProviders ||
        typeof entry.mayRequireTypedInput !== 'boolean' ||
        (entry.status === 'DECLARED_NOT_EXECUTED' && entry.providerNames.length === 0) ||
        (entry.status === 'NOT_ADVERTISED_WITH_EMPTY_INPUT' && entry.providerNames.length !== 0) ||
        (entry.canonicalRisk === 'dynamic' &&
          entry.dynamicRiskStatus !== 'REQUIRES_TYPED_INPUT_AND_FRESH_AUTHORIZATION') ||
        !['DECLARED_NOT_EXECUTED','NOT_ADVERTISED_WITH_EMPTY_INPUT',
          'PROBE_INDETERMINATE'].includes(entry.status) ||
        entry.authorizationStatus !== 'NOT_CHECKED' ||
        entry.operationalStatus !== 'NOT_TESTED' ||
        entry.outputVerificationStatus !== 'NOT_TESTED') {
      invalid('Provider declarations must remain unique and not claim unobserved authority.');
    }
    seen.add(entry.capability);
    const group = family(entry.capability);
    const permittedByScope = listed(entry.capability,scope);
    let state: Advertised;
    if (input.emergencyStopped) state = 'EMERGENCY_STOPPED';
    else if (!permittedByScope) state = 'SCOPE_NOT_LISTED';
    else if (group === 'FILESYSTEM' && input.permissions.allowedRoots.length === 0) state = 'ROOT_SCOPE_MISSING';
    else if (entry.status === 'PROBE_INDETERMINATE') state = 'PROVIDER_PROBE_INDETERMINATE';
    else if (entry.status === 'NOT_ADVERTISED_WITH_EMPTY_INPUT') state = 'REQUIRES_TYPED_INPUT';
    else if (entry.providerNames.length === 0) state = 'NOT_ADVERTISED';
    else state = 'PROVIDER_DECLARED_NOT_EXECUTION_TESTED';
    capabilities.push({
      capability: entry.capability,
      canonicalRisk: entry.canonicalRisk,
      providerNames: [...entry.providerNames].sort(),
      family: group, state,
      sourceOnly: true,
      requiresFreshAuthorization: true,
      currentPhysicalOperation: 'NOT_TESTED'
    });
  }
  return {
    schemaVersion:1,
    source:'CURRENT_PROVIDER_REGISTRY_AND_REQUEST_PERMISSION_PROFILE',
    snapshotKind:'DECLARATIONS_NOT_EXECUTION',
    platform:safePlatform(input.platform),
    emergencyStopped:input.emergencyStopped,
    authorizedRootCount:input.permissions.allowedRoots.length,
    capabilities,
    privacy:'NO_TARGET_PATHS_OR_ACCOUNT_IDS',
    authority:'NEVER_A_GRANT',
    deviceAndSessionReadiness:'NOT_VERIFIED'
  };
}
