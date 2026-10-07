import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ActionRequest, ActionResult, ActionRisk, CapabilityExecutionContext, CapabilityProvider, CapabilityScore, ProviderReconciliationRequest, ProviderReconciliationResult } from './types.ts';
import type { SignedCapabilityPackage } from './capability-package-registry.ts';
import { CapabilityGovernanceRegistry } from './capability-governance.ts';
import { OperatorError } from './errors.ts';
import { isBuiltInCapability, registerExtensionCapabilityRisk } from './capability-policy.ts';

export interface CapabilityModuleFactory {
  createCapabilityProvider?: (input: { manifest: SignedCapabilityPackage['manifest'] }) => CapabilityProvider | Promise<CapabilityProvider>;
  default?: unknown;
}

export async function loadGovernedCapabilityModule(input: {
  modulePath: string;
  allowedRoots: string[];
  package: SignedCapabilityPackage;
  governance: CapabilityGovernanceRegistry;
}): Promise<CapabilityProvider> {
  const admission = input.governance.currentAdmission(input.package);
  if (!admission.allowed || !admission.entry) throw new OperatorError('CAPABILITY_PACKAGE_NOT_ADMITTED', `Capability package admission failed before load: ${admission.reason}.`);
  const riskReleases: Array<() => void> = [];
  try {
    for (const capability of input.package.manifest.capabilities) {
      if (isBuiltInCapability(capability.capability)) continue;
      riskReleases.push(registerExtensionCapabilityRisk({
        capability: capability.capability,
        rule: capability.risk,
        extensionId: input.package.manifest.id,
        owner: admission.entry.packageId
      }));
    }
  } catch (error) {
    for (const release of riskReleases.reverse()) release();
    throw error;
  }
  try {
    const modulePath = await resolveAllowedExisting(input.modulePath, input.allowedRoots);
    const stat = await fs.stat(modulePath);
    if (!stat.isFile() || stat.size < 1 || stat.size > 8 * 1024 * 1024) {
      throw new OperatorError('CAPABILITY_MODULE_SIZE_INVALID', 'Capability module must be a regular file between 1 byte and 8 MiB.');
    }
    const bytes = await fs.readFile(modulePath);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== input.package.manifest.provenance.packageDigest) {
      throw new OperatorError('CAPABILITY_MODULE_DIGEST_MISMATCH', 'Capability module bytes do not match the signed manifest package digest.');
    }
    // Import the exact verified bytes rather than re-opening the path after
    // verification. This closes hash→execute TOCTOU and makes packageDigest
    // cover every executable byte in the extension entry module.
    const encoded = bytes.toString('base64');
    const namespace = await import(`data:text/javascript;base64,${encoded}#sha256=${digest}`) as CapabilityModuleFactory;
    const factory = typeof namespace.createCapabilityProvider === 'function'
      ? namespace.createCapabilityProvider
      : typeof namespace.default === 'function'
        ? namespace.default as CapabilityModuleFactory['createCapabilityProvider']
        : undefined;
    if (!factory) throw new OperatorError('CAPABILITY_MODULE_FACTORY_MISSING', 'Capability module must export createCapabilityProvider(manifest) or a default factory.');
    const provider = await factory({ manifest: structuredClone(input.package.manifest) });
    if (!provider || typeof provider.name !== 'string' || typeof provider.execute !== 'function') {
      throw new OperatorError('CAPABILITY_MODULE_PROVIDER_INVALID', 'Capability module factory returned an invalid provider.');
    }
    return new RiskPolicyBoundProvider(input.governance.wrap(input.package, provider), riskReleases);
  } catch (error) {
    for (const release of riskReleases.reverse()) release();
    throw error;
  }
}

class RiskPolicyBoundProvider implements CapabilityProvider {
  readonly name: string;
  #provider: CapabilityProvider;
  #releases: Array<() => void>;
  #closed = false;
  constructor(provider: CapabilityProvider, releases: Array<() => void>) {
    this.#provider = provider;
    this.#releases = releases;
    this.name = provider.name;
  }
  supports(action: ActionRequest): boolean | Promise<boolean> { return this.#provider.supports(action); }
  advertises(action: ActionRequest): boolean | Promise<boolean> { return this.#provider.advertises ? this.#provider.advertises(action) : this.#provider.supports(action); }
  score(action: ActionRequest): CapabilityScore | Promise<CapabilityScore> { return this.#provider.score(action); }
  resolveRisk(action: ActionRequest): ActionRisk | Promise<ActionRisk> {
    if (!this.#provider.resolveRisk) {
      throw new OperatorError('CAPABILITY_RISK_UNRESOLVED', 'Extension provider has no dynamic-risk resolver.');
    }
    return this.#provider.resolveRisk(action);
  }
  execute(action: ActionRequest, context?: CapabilityExecutionContext): Promise<ActionResult> { return this.#provider.execute(action, context); }
  reconcile(request: ProviderReconciliationRequest, context?: CapabilityExecutionContext): Promise<ProviderReconciliationResult> {
    if (!this.#provider.reconcile) return Promise.reject(new OperatorError('CAPABILITY_EXTENSION_RECONCILIATION_UNAVAILABLE','Extension provider has no reconciliation contract.'));
    return this.#provider.reconcile(request, context);
  }
  initialize(): void | Promise<void> { return this.#provider.initialize?.(); }
  emergencyStop(): void | Promise<void> { return this.#provider.emergencyStop?.(); }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try { await this.#provider.close?.(); }
    finally { for (const release of this.#releases.reverse()) release(); this.#releases = []; }
  }
}

async function resolveAllowedExisting(inputPath:string, roots:string[]):Promise<string> {
  if (!Array.isArray(roots) || roots.length < 1 || roots.length > 128) throw new OperatorError('CAPABILITY_MODULE_ROOTS_INVALID','At least one authorized module root is required.');
  const real = await fs.realpath(path.resolve(inputPath));
  const resolvedRoots = await Promise.all(roots.map(async root => {
    try { return await fs.realpath(path.resolve(root)); } catch { return path.resolve(root); }
  }));
  const allowed = resolvedRoots.some(root => {
    const rel = path.relative(root, real);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  if (!allowed) throw new OperatorError('CAPABILITY_MODULE_OUTSIDE_SCOPE','Capability module path escapes authorized module roots.');
  return real;
}
