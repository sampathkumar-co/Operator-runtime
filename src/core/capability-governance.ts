import type { CapabilityProvider, ActionRequest, ActionResult, CapabilityExecutionContext, CapabilityScore, ProviderReconciliationRequest, ProviderReconciliationResult } from './types.ts';
import { CapabilityExtensionRegistry } from './capability-sdk.ts';
import {
  admitCapabilityPackage,
  type CapabilityPublisherIdentity,
  type SignedCapabilityPackage,
  type CapabilityRegistryAdmission
} from './capability-package-registry.ts';
import {
  createCapabilityRevocation,
  type CapabilityRevocationRecord
} from './capability-conformance.ts';
import { OperatorError } from './errors.ts';

export class CapabilityGovernanceRegistry {
  #publishers = new Map<string, CapabilityPublisherIdentity>();
  #packages = new Map<string, SignedCapabilityPackage>();
  #revocations: CapabilityRevocationRecord[] = [];

  upsertPublisher(input: CapabilityPublisherIdentity): void {
    if (!input || typeof input.id !== 'string') throw invalid('Publisher identity is required.');
    this.#publishers.set(input.id, structuredClone(input));
  }

  disablePublisher(publisherId: string): void {
    const current = this.#publishers.get(publisherId);
    if (!current) throw invalid('Publisher is unknown.');
    this.#publishers.set(publisherId, { ...current, enabled: false });
  }

  enablePublisher(publisherId: string): void {
    const current = this.#publishers.get(publisherId);
    if (!current) throw invalid('Publisher is unknown.');
    this.#publishers.set(publisherId, { ...current, enabled: true });
  }

  admit(pkg: SignedCapabilityPackage): CapabilityRegistryAdmission {
    const decision = admitCapabilityPackage({
      package: pkg,
      publishers: [...this.#publishers.values()],
      revocations: this.#revocations,
      requireGovernanceMetadata: true
    });
    if (decision.allowed && decision.entry) this.#packages.set(decision.entry.packageId, structuredClone(pkg));
    return decision;
  }

  currentAdmission(pkg: SignedCapabilityPackage): CapabilityRegistryAdmission {
    return admitCapabilityPackage({
      package: pkg,
      publishers: [...this.#publishers.values()],
      revocations: this.#revocations,
      requireGovernanceMetadata: true
    });
  }

  revokePackage(pkg: SignedCapabilityPackage, input: {
    reasonCode: string;
    evidenceArtifactIds: string[];
    revokedAt?: string;
  }): CapabilityRevocationRecord {
    const revocation = createCapabilityRevocation({
      certificationId: pkg.certification.id,
      manifestDigest: pkg.certification.manifestDigest,
      reasonCode: input.reasonCode,
      evidenceArtifactIds: input.evidenceArtifactIds,
      ...(input.revokedAt ? { revokedAt: input.revokedAt } : {})
    });
    this.#revocations.push(revocation);
    return structuredClone(revocation);
  }

  listRevocations(): CapabilityRevocationRecord[] {
    return this.#revocations.map((item) => structuredClone(item));
  }

  wrap(pkg: SignedCapabilityPackage, provider: CapabilityProvider): CapabilityProvider {
    const first = this.admit(pkg);
    if (!first.allowed) throw new OperatorError('CAPABILITY_PACKAGE_NOT_ADMITTED', `Capability package admission failed: ${first.reason}.`);
    const manifestBound = new CapabilityExtensionRegistry().register(pkg.manifest, provider);
    return new LiveGovernedProvider(this, pkg, manifestBound);
  }
}

class LiveGovernedProvider implements CapabilityProvider {
  readonly name: string;
  #governance: CapabilityGovernanceRegistry;
  #pkg: SignedCapabilityPackage;
  #provider: CapabilityProvider;

  constructor(governance: CapabilityGovernanceRegistry, pkg: SignedCapabilityPackage, provider: CapabilityProvider) {
    this.#governance = governance;
    this.#pkg = structuredClone(pkg);
    this.#provider = provider;
    this.name = provider.name;
  }

  #assertAdmitted(): void {
    const decision = this.#governance.currentAdmission(this.#pkg);
    if (!decision.allowed) {
      throw new OperatorError('CAPABILITY_PACKAGE_REVOKED', `Capability package is no longer admitted: ${decision.reason}.`, {
        retryable: false,
        details: { reason: decision.reason }
      });
    }
  }

  supports(action: ActionRequest): boolean | Promise<boolean> {
    const decision = this.#governance.currentAdmission(this.#pkg);
    if (!decision.allowed) return false;
    return this.#provider.supports(action);
  }

  advertises(action: ActionRequest): boolean | Promise<boolean> {
    const decision = this.#governance.currentAdmission(this.#pkg);
    if (!decision.allowed) return false;
    return this.#provider.advertises ? this.#provider.advertises(action) : this.#provider.supports(action);
  }

  score(action: ActionRequest): CapabilityScore | Promise<CapabilityScore> {
    this.#assertAdmitted();
    return this.#provider.score(action);
  }

  resolveRisk(action: ActionRequest) {
    this.#assertAdmitted();
    return this.#provider.resolveRisk?.(action);
  }

  async execute(action: ActionRequest, context?: CapabilityExecutionContext): Promise<ActionResult> {
    this.#assertAdmitted();
    const result = await this.#provider.execute(action, context);
    this.#assertAdmitted();
    return result;
  }

  async reconcile(request: ProviderReconciliationRequest, context?: CapabilityExecutionContext): Promise<ProviderReconciliationResult> {
    this.#assertAdmitted();
    if (!this.#provider.reconcile) throw new OperatorError('CAPABILITY_EXTENSION_RECONCILIATION_UNAVAILABLE', 'Governed provider has no reconciliation contract.');
    const result = await this.#provider.reconcile(request, context);
    this.#assertAdmitted();
    return result;
  }

  async initialize(): Promise<void> { this.#assertAdmitted(); await this.#provider.initialize?.(); }
  async emergencyStop(): Promise<void> { await this.#provider.emergencyStop?.(); }
  async close(): Promise<void> { await this.#provider.close?.(); }
}

function invalid(message:string):OperatorError {
  return new OperatorError('CAPABILITY_GOVERNANCE_INVALID', message);
}
