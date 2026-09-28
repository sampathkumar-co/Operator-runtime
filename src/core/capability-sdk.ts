import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { capabilityRiskRule, type CapabilityRiskRule } from './capability-policy.ts';
import { OperatorError } from './errors.ts';
import type { ActionRequest, ActionResult, CapabilityExecutionContext, CapabilityProvider, CapabilityScore } from './types.ts';

export interface CapabilityManifestEntry {
  capability: string;
  risk: CapabilityRiskRule;
  deterministic: boolean;
  reversible: boolean;
  verification: 'provider' | 'runtime' | 'external';
  resourceKinds: string[];
}

export interface CapabilityExtensionManifest {
  sdkVersion: 1;
  id: string;
  version: string;
  displayName: string;
  vendor?: string;
  capabilities: CapabilityManifestEntry[];
}

export interface RegisteredCapabilityExtension {
  manifest: CapabilityExtensionManifest;
  digest: string;
}

const MAX_CAPABILITIES = 256;

export class CapabilityExtensionRegistry {
  #extensions = new Map<string, RegisteredCapabilityExtension>();

  register(manifestInput: CapabilityExtensionManifest, provider: CapabilityProvider): CapabilityProvider {
    const manifest = validateManifest(manifestInput);
    if (this.#extensions.has(manifest.id)) throw new OperatorError('CAPABILITY_EXTENSION_DUPLICATE', `Extension ${manifest.id} is already registered.`);
    const digest = capabilityManifestDigest(manifest);
    this.#extensions.set(manifest.id, { manifest, digest });
    return new ManifestBoundProvider(manifest, provider);
  }

  list(): RegisteredCapabilityExtension[] {
    return [...this.#extensions.values()]
      .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
      .map((item) => structuredClone(item));
  }

  inspect(idInput: string): RegisteredCapabilityExtension | undefined {
    const id = extensionId(idInput, 'id');
    const item = this.#extensions.get(id);
    return item ? structuredClone(item) : undefined;
  }
}

class ManifestBoundProvider implements CapabilityProvider {
  readonly name: string;
  #manifest: CapabilityExtensionManifest;
  #provider: CapabilityProvider;
  #allowed: Set<string>;

  constructor(manifest: CapabilityExtensionManifest, provider: CapabilityProvider) {
    this.#manifest = manifest;
    this.#provider = provider;
    this.name = `extension:${manifest.id}:${provider.name}`;
    this.#allowed = new Set(manifest.capabilities.map((entry) => entry.capability));
  }

  supports(action: ActionRequest): boolean | Promise<boolean> {
    if (!this.#allowed.has(action.capability)) return false;
    return this.#provider.supports(action);
  }

  advertises(action: ActionRequest): boolean | Promise<boolean> {
    if (!this.#allowed.has(action.capability)) return false;
    return this.#provider.advertises ? this.#provider.advertises(action) : this.#provider.supports(action);
  }

  score(action: ActionRequest): CapabilityScore | Promise<CapabilityScore> {
    if (!this.#allowed.has(action.capability)) throw new OperatorError('CAPABILITY_EXTENSION_SCOPE_DENIED', 'Extension was asked to score an undeclared capability.');
    return this.#provider.score(action);
  }

  resolveRisk(action: ActionRequest) {
    if (!this.#allowed.has(action.capability)) throw new OperatorError('CAPABILITY_EXTENSION_SCOPE_DENIED', 'Extension was asked to resolve risk for an undeclared capability.');
    return this.#provider.resolveRisk?.(action) ?? declaredRisk(this.#manifest, action.capability);
  }

  async execute(action: ActionRequest, context?: CapabilityExecutionContext): Promise<ActionResult> {
    if (!this.#allowed.has(action.capability)) throw new OperatorError('CAPABILITY_EXTENSION_SCOPE_DENIED', 'Extension cannot execute an undeclared capability.');
    const result = await this.#provider.execute(action, context);
    if (result.capability !== action.capability) {
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [],
        error: {
          code: 'CAPABILITY_EXTENSION_RESULT_INVALID',
          message: 'Extension returned a result for a different capability.',
          retryable: false,
          sideEffectState: action.risk === 'read' ? 'none' : 'uncertain'
        },
        durationMs: result.durationMs
      };
    }
    return { ...result, provider: this.name };
  }

  async close(): Promise<void> {
    await this.#provider.close?.();
  }
}

export function validateManifest(input: CapabilityExtensionManifest): CapabilityExtensionManifest {
  if (!input || typeof input !== 'object' || input.sdkVersion !== 1) throw new OperatorError('CAPABILITY_MANIFEST_INVALID', 'Capability extension sdkVersion must be 1.');
  const id = extensionId(input.id, 'id');
  const version = semver(input.version);
  const displayName = bounded(input.displayName, 256, 'displayName');
  const vendor = input.vendor === undefined ? undefined : bounded(input.vendor, 256, 'vendor');
  if (!Array.isArray(input.capabilities) || input.capabilities.length < 1 || input.capabilities.length > MAX_CAPABILITIES) {
    throw new OperatorError('CAPABILITY_MANIFEST_INVALID', `Capability manifest must declare 1-${MAX_CAPABILITIES} capabilities.`);
  }
  const seen = new Set<string>();
  const capabilities = input.capabilities.map((entry, index) => {
    const capability = capabilityName(entry.capability, `capabilities[${index}].capability`);
    if (seen.has(capability)) throw new OperatorError('CAPABILITY_MANIFEST_INVALID', 'Capability manifest contains duplicate capabilities.');
    seen.add(capability);
    const canonical = capabilityRiskRule(capability);
    if (entry.risk !== canonical) {
      throw new OperatorError('CAPABILITY_MANIFEST_RISK_MISMATCH', `Extension risk for ${capability} must match the canonical runtime policy.`, {
        details: { declared: entry.risk, canonical }
      });
    }
    if (typeof entry.deterministic !== 'boolean' || typeof entry.reversible !== 'boolean') throw new OperatorError('CAPABILITY_MANIFEST_INVALID', 'Capability deterministic/reversible flags are required.');
    if (entry.verification !== 'provider' && entry.verification !== 'runtime' && entry.verification !== 'external') throw new OperatorError('CAPABILITY_MANIFEST_INVALID', 'Capability verification mode is invalid.');
    const resourceKinds = uniqueResourceKinds(entry.resourceKinds, index);
    return { capability, risk: canonical, deterministic: entry.deterministic, reversible: entry.reversible, verification: entry.verification, resourceKinds };
  }).sort((a, b) => a.capability.localeCompare(b.capability));
  return { sdkVersion: 1, id, version, displayName, ...(vendor ? { vendor } : {}), capabilities };
}

export function capabilityManifestDigest(manifest: CapabilityExtensionManifest): string {
  return crypto.createHash('sha256').update(canonicalJson(validateManifest(manifest))).digest('hex');
}

function declaredRisk(manifest: CapabilityExtensionManifest, capability: string): CapabilityRiskRule {
  const entry = manifest.capabilities.find((candidate) => candidate.capability === capability);
  if (!entry) throw new OperatorError('CAPABILITY_EXTENSION_SCOPE_DENIED', 'Capability is not declared by extension.');
  return entry.risk;
}

function uniqueResourceKinds(input: unknown, index: number): string[] {
  if (!Array.isArray(input) || input.length > 64) throw new OperatorError('CAPABILITY_MANIFEST_INVALID', `capabilities[${index}].resourceKinds is invalid.`);
  const values = input.map((value, child) => {
    const text = bounded(value, 128, `capabilities[${index}].resourceKinds[${child}]`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) throw new OperatorError('CAPABILITY_MANIFEST_INVALID', 'Resource kind contains unsupported characters.');
    return text;
  });
  if (new Set(values).size !== values.length) throw new OperatorError('CAPABILITY_MANIFEST_INVALID', 'Resource kinds contain duplicates.');
  return values.sort();
}
function extensionId(input: unknown, label: string): string {
  const value = bounded(input, 128, label);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) throw new OperatorError('CAPABILITY_MANIFEST_INVALID', `${label} is invalid.`);
  return value;
}
function capabilityName(input: unknown, label: string): string {
  const value = bounded(input, 128, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new OperatorError('CAPABILITY_MANIFEST_INVALID', `${label} is invalid.`);
  return value;
}
function semver(input: unknown): string {
  const value = bounded(input, 64, 'version');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new OperatorError('CAPABILITY_MANIFEST_INVALID', 'version must be SemVer.');
  }
  return value;
}
function bounded(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0') || /[\r\n]/.test(input)) throw new OperatorError('CAPABILITY_MANIFEST_INVALID', `${label} is invalid.`);
  return input;
}
