import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { CAPABILITY_RISK_RULES, isBuiltInCapability, type CapabilityRiskRule } from './capability-policy.ts';
import { OperatorError } from './errors.ts';
import { normalizeVerifiedModuleGraph, verifiedModuleGraphDigest, type VerifiedModuleGraph } from './verified-module-graph.ts';
import type { ActionRequest, ActionResult, ActionRisk, CapabilityExecutionContext, CapabilityProvider, CapabilityScore, ProviderReconciliationRequest, ProviderReconciliationResult } from './types.ts';

export interface CapabilityManifestEntry {
  capability: string;
  risk: CapabilityRiskRule;
  deterministic: boolean;
  reversible: boolean;
  verification: 'provider' | 'runtime' | 'external';
  reconciliation: 'provider' | 'not-required';
  inputSchemaVersion: 1;
  inputMaxBytes: number;
  outputMaxBytes: number;
  cancellation: 'required';
  resourceKinds: string[];
}

export interface CapabilityExtensionManifest {
  sdkVersion: 1;
  id: string;
  version: string;
  displayName: string;
  vendor?: string;
  provenance: { source: string; packageDigest: string; moduleGraph?: VerifiedModuleGraph };
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
    if (!provider || typeof provider.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(provider.name) || provider.name.startsWith('extension:')) {
      throw new OperatorError('CAPABILITY_EXTENSION_PROVIDER_INVALID', 'Extension provider identity is invalid.');
    }
    if (manifest.capabilities.some((entry) => entry.reconciliation === 'provider') && typeof provider.reconcile !== 'function') {
      throw new OperatorError('CAPABILITY_EXTENSION_RECONCILIATION_REQUIRED', 'A mutable extension capability requires a provider reconciliation implementation.');
    }
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
  #entries: Map<string, CapabilityManifestEntry>;

  constructor(manifest: CapabilityExtensionManifest, provider: CapabilityProvider) {
    this.#manifest = manifest;
    this.#provider = provider;
    this.name = `extension:${manifest.id}:${provider.name}`;
    this.#allowed = new Set(manifest.capabilities.map((entry) => entry.capability));
    this.#entries = new Map(manifest.capabilities.map((entry) => [entry.capability, entry]));
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

  resolveRisk(action: ActionRequest): ActionRisk | Promise<ActionRisk> {
    if (!this.#allowed.has(action.capability)) throw new OperatorError('CAPABILITY_EXTENSION_SCOPE_DENIED', 'Extension was asked to resolve risk for an undeclared capability.');
    if (this.#provider.resolveRisk) return this.#provider.resolveRisk(action);
    const risk = declaredRisk(this.#manifest, action.capability);
    if (risk === 'dynamic') {
      throw new OperatorError('CAPABILITY_EXTENSION_DYNAMIC_RISK_UNRESOLVED', 'Dynamic-risk extension capability requires a trusted provider risk resolver.');
    }
    return risk;
  }

  async execute(action: ActionRequest, context?: CapabilityExecutionContext): Promise<ActionResult> {
    if (!this.#allowed.has(action.capability)) throw new OperatorError('CAPABILITY_EXTENSION_SCOPE_DENIED', 'Extension cannot execute an undeclared capability.');
    const contract = this.#entries.get(action.capability)!;
    if (jsonBytes(action.input) > contract.inputMaxBytes) throw new OperatorError('CAPABILITY_EXTENSION_INPUT_TOO_LARGE', 'Extension input exceeds its declared bound.');
    if (context?.signal?.aborted) throw new OperatorError('EXECUTION_ABORTED', 'Extension execution was cancelled before dispatch.');
    const result = await this.#provider.execute(action, context);
    if (context?.signal?.aborted) throw new OperatorError('EXECUTION_ABORTED', 'Extension execution was cancelled.');
    if (!validResult(result) || result.capability !== action.capability || result.provider !== this.#provider.name || jsonBytes(result.output) > contract.outputMaxBytes) {
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [],
        error: {
          code: 'CAPABILITY_EXTENSION_RESULT_INVALID',
          message: 'Extension result violated capability, provider identity, schema, or output-bound contract.',
          retryable: false,
          sideEffectState: action.risk === 'read' ? 'none' : 'uncertain'
        },
        durationMs: result.durationMs
      };
    }
    return { ...result, provider: this.name };
  }

  async reconcile(request: ProviderReconciliationRequest, context?: CapabilityExecutionContext): Promise<ProviderReconciliationResult> {
    if (!this.#allowed.has(request.action.capability)) throw new OperatorError('CAPABILITY_EXTENSION_SCOPE_DENIED', 'Extension cannot reconcile an undeclared capability.');
    const contract = this.#entries.get(request.action.capability)!;
    if (contract.reconciliation !== 'provider' || !this.#provider.reconcile) {
      throw new OperatorError('CAPABILITY_EXTENSION_RECONCILIATION_UNAVAILABLE', 'Extension capability has no provider reconciliation contract.');
    }
    const outcome = await this.#provider.reconcile(request, context);
    if (!outcome || !['completed', 'not_applied', 'uncertain'].includes(outcome.status) || !Array.isArray(outcome.evidence)) {
      throw new OperatorError('CAPABILITY_EXTENSION_RECONCILIATION_INVALID', 'Extension returned an invalid reconciliation result.');
    }
    if (outcome.result && jsonBytes(outcome.result.output) > contract.outputMaxBytes) throw new OperatorError('CAPABILITY_EXTENSION_RESULT_INVALID', 'Reconciled extension output exceeds its declared bound.');
    return outcome.result ? { ...outcome, result: { ...outcome.result, provider: this.name } } : outcome;
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
  if (!input.provenance || typeof input.provenance !== 'object') throw new OperatorError('CAPABILITY_MANIFEST_INVALID', 'Extension provenance is required.');
  const provenance = {
    source: bounded(input.provenance.source, 512, 'provenance.source'),
    packageDigest: bounded(input.provenance.packageDigest, 64, 'provenance.packageDigest'),
    ...(input.provenance.moduleGraph === undefined ? {} : { moduleGraph: normalizeVerifiedModuleGraph(input.provenance.moduleGraph) })
  };
  if (!/^[0-9a-f]{64}$/.test(provenance.packageDigest)) throw new OperatorError('CAPABILITY_MANIFEST_INVALID', 'provenance.packageDigest must be a lowercase SHA-256 digest.');
  if (provenance.moduleGraph && verifiedModuleGraphDigest(provenance.moduleGraph) !== provenance.packageDigest) {
    throw new OperatorError('CAPABILITY_MODULE_GRAPH_INVALID', 'Publisher package digest must cover the entire signed module graph manifest.');
  }
  if (!Array.isArray(input.capabilities) || input.capabilities.length < 1 || input.capabilities.length > MAX_CAPABILITIES) {
    throw new OperatorError('CAPABILITY_MANIFEST_INVALID', `Capability manifest must declare 1-${MAX_CAPABILITIES} capabilities.`);
  }
  const seen = new Set<string>();
  const capabilities = input.capabilities.map((entry, index) => {
    const capability = capabilityName(entry.capability, `capabilities[${index}].capability`);
    if (seen.has(capability)) throw new OperatorError('CAPABILITY_MANIFEST_INVALID', 'Capability manifest contains duplicate capabilities.');
    seen.add(capability);
    let canonical: CapabilityRiskRule;
    if (isBuiltInCapability(capability)) {
      canonical = CAPABILITY_RISK_RULES[capability]!;
      if (entry.risk !== canonical) {
        throw new OperatorError('CAPABILITY_MANIFEST_RISK_MISMATCH', `Extension risk for ${capability} must match the canonical runtime policy.`, {
          details: { declared: entry.risk, canonical }
        });
      }
    } else {
      const prefix = `ext.${id}.`;
      if (!capability.startsWith(prefix)) {
        throw new OperatorError('CAPABILITY_MANIFEST_NAMESPACE_INVALID', `New extension capabilities must be namespaced under ${prefix}.`);
      }
      if (!['read','write','external','system','destructive','dynamic'].includes(entry.risk)) {
        throw new OperatorError('CAPABILITY_MANIFEST_RISK_MISMATCH', 'Extension capability risk declaration is invalid.');
      }
      canonical = entry.risk;
    }
    if (typeof entry.deterministic !== 'boolean' || typeof entry.reversible !== 'boolean') throw new OperatorError('CAPABILITY_MANIFEST_INVALID', 'Capability deterministic/reversible flags are required.');
    if (entry.verification !== 'provider' && entry.verification !== 'runtime' && entry.verification !== 'external') throw new OperatorError('CAPABILITY_MANIFEST_INVALID', 'Capability verification mode is invalid.');
    if (entry.reconciliation !== 'provider' && entry.reconciliation !== 'not-required') throw new OperatorError('CAPABILITY_MANIFEST_INVALID', 'Capability reconciliation mode is invalid.');
    if (canonical !== 'read' && entry.reconciliation !== 'provider') throw new OperatorError('CAPABILITY_MANIFEST_INVALID', 'Mutable extension capabilities require provider reconciliation.');
    if (entry.inputSchemaVersion !== 1 || entry.cancellation !== 'required') throw new OperatorError('CAPABILITY_MANIFEST_INVALID', 'Capability schema version and cancellation contract are required.');
    const inputMaxBytes = contractBytes(entry.inputMaxBytes, `capabilities[${index}].inputMaxBytes`);
    const outputMaxBytes = contractBytes(entry.outputMaxBytes, `capabilities[${index}].outputMaxBytes`);
    const resourceKinds = uniqueResourceKinds(entry.resourceKinds, index);
    return { capability, risk: canonical, deterministic: entry.deterministic, reversible: entry.reversible, verification: entry.verification, reconciliation: entry.reconciliation, inputSchemaVersion: 1 as const, inputMaxBytes, outputMaxBytes, cancellation: 'required' as const, resourceKinds };
  }).sort((a, b) => a.capability.localeCompare(b.capability));
  return { sdkVersion: 1, id, version, displayName, ...(vendor ? { vendor } : {}), provenance, capabilities };
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

function contractBytes(input: unknown, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < 1024 || value > 4 * 1024 * 1024) throw new OperatorError('CAPABILITY_MANIFEST_INVALID', `${label} must be 1024-4194304.`);
  return value;
}

function jsonBytes(input: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(input ?? null), 'utf8'); }
  catch { return Number.POSITIVE_INFINITY; }
}

function validResult(result: unknown): result is ActionResult {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const value = result as ActionResult;
  return typeof value.ok === 'boolean' && typeof value.capability === 'string' && typeof value.provider === 'string'
    && Array.isArray(value.evidence) && Number.isFinite(value.durationMs) && value.durationMs >= 0;
}
