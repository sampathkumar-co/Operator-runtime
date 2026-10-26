import type { ActionRequest, ActionRisk, CapabilityProvider, CapabilityScore, ProviderCapabilitySchema } from './types.ts';
import { OperatorError } from './errors.ts';
import type { ProviderLearning } from './provider-learning.ts';

const WEIGHTS: Record<keyof CapabilityScore, number> = {
  reliability: 0.24,
  latency: 0.13,
  determinism: 0.19,
  security: 0.17,
  reversibility: 0.10,
  informationQuality: 0.12,
  interactionCost: 0.05
};

function normalize(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score));
}

const KNOWN_RISKS = new Set<ActionRisk>(['read', 'write', 'external', 'system', 'destructive']);

async function providerSupports(provider: CapabilityProvider, action: ActionRequest): Promise<boolean> {
  const supported = await provider.supports(action);
  if (typeof supported !== 'boolean') {
    throw new OperatorError('PROVIDER_SUPPORT_CONTRACT_INVALID',
      `Provider ${provider.name} returned a non-boolean supports() declaration.`);
  }
  return supported;
}

async function providerAdvertises(provider: CapabilityProvider, action: ActionRequest): Promise<boolean> {
  if (!provider.advertises) return true;
  const advertised = await provider.advertises(action);
  if (typeof advertised !== 'boolean') {
    throw new OperatorError('PROVIDER_ADVERTISEMENT_CONTRACT_INVALID',
      `Provider ${provider.name} returned a non-boolean advertises() declaration.`);
  }
  return advertised;
}

function checkedScore(score: CapabilityScore, providerName: string): CapabilityScore {
  if (!score || typeof score !== 'object' || Array.isArray(score) ||
    Object.keys(WEIGHTS).some((key) => {
      const value = score[key as keyof CapabilityScore];
      return typeof value !== 'number' || !Number.isFinite(value);
    })) {
    throw new OperatorError('PROVIDER_SCORE_CONTRACT_INVALID',
      `Provider ${providerName} returned an invalid capability score.`);
  }
  return score;
}

function weightedScore(score: CapabilityScore): number {
  return Object.entries(WEIGHTS).reduce((total, [key, weight]) => {
    const raw = score[key as keyof CapabilityScore];
    const value = key === 'latency' || key === 'interactionCost' ? 1 - normalize(raw) : normalize(raw);
    return total + value * weight;
  }, 0);
}

export class CapabilityRouter {
  #providers: CapabilityProvider[] = [];
  #learning?: ProviderLearning;

  constructor(options: { learning?: ProviderLearning } = {}) {
    this.#learning = options.learning;
  }

  register(provider: CapabilityProvider): void {
    this.#providers.push(provider);
  }

  async supports(action: ActionRequest): Promise<boolean> {
    for (const provider of this.#providers) {
      if (await providerSupports(provider, action)) return true;
    }
    return false;
  }

  async advertises(action: ActionRequest): Promise<boolean> {
    for (const provider of this.#providers) {
      if (!await providerSupports(provider, action)) continue;
      if (await providerAdvertises(provider, action)) return true;
    }
    return false;
  }

  async rank(action: ActionRequest, learningContext = 'global'): Promise<Array<{ provider: CapabilityProvider; score: number; baseScore: number; learnedAdjustment: number }>> {
    const candidates: Array<{ provider: CapabilityProvider; score: number; baseScore: number; learnedAdjustment: number }> = [];
    for (const provider of this.#providers) {
      if (await providerSupports(provider, action)) {
        const baseScore = weightedScore(checkedScore(await provider.score(action), provider.name));
        const learnedAdjustment = this.#learning ? await this.#learning.adjustment(action.capability, provider.name, learningContext) : 0;
        candidates.push({ provider, baseScore, learnedAdjustment, score: normalize(baseScore + learnedAdjustment) });
      }
    }
    candidates.sort((a, b) => b.score - a.score || b.baseScore - a.baseScore || a.provider.name.localeCompare(b.provider.name));
    return candidates;
  }

  async recordOutcome(capability: string, providerName: string, outcome: 'verified' | 'failed', metadata: { context?: string; durationMs?: number } = {}): Promise<boolean> {
    if (!this.#learning) return false;
    if (!this.#providers.some((provider) => provider.name === providerName)) return false;
    await this.#learning.record(capability, providerName, outcome, metadata);
    return true;
  }

  async resolveRisk(action: ActionRequest): Promise<ActionRisk> {
    const risks = new Set<ActionRisk>();
    for (const provider of this.#providers) {
      if (await providerSupports(provider, action) && provider.resolveRisk) {
        const resolved = await provider.resolveRisk(action);
        if (typeof resolved !== 'string' || !KNOWN_RISKS.has(resolved as ActionRisk)) {
          throw new OperatorError('PROVIDER_RISK_CONTRACT_INVALID',
            `Provider ${provider.name} returned an invalid dynamic risk.`);
        }
        risks.add(resolved as ActionRisk);
      }
    }
    if (risks.size !== 1) throw new OperatorError('CAPABILITY_RISK_UNRESOLVED', `Capability ${action.capability} does not have one trusted dynamic risk.`);
    return [...risks][0]!;
  }

  async provider(name: string): Promise<CapabilityProvider | undefined> {
    return this.#providers.find((provider) => provider.name === name);
  }

  providers(): readonly CapabilityProvider[] {
    return [...this.#providers];
  }

  /** Returns only schemas declared by providers that currently support the exact
   * typed action. A declaration is never treated as authority or availability. */
  async capabilitySchemas(action: ActionRequest): Promise<Array<ProviderCapabilitySchema & { provider: string }>> {
    const schemas: Array<ProviderCapabilitySchema & { provider: string }> = [];
    for (const provider of this.#providers) {
      if (!provider.capabilitySchemas || !await providerSupports(provider, action)) continue;
      const declared = provider.capabilitySchemas().filter((entry) => entry.capability === action.capability);
      for (const entry of declared) {
        if (!entry || entry.inputSchemaVersion !== 1 || entry.cancellation !== 'required'
          || !['read', 'write', 'external', 'system', 'destructive', 'dynamic'].includes(entry.risk)
          || !Number.isSafeInteger(entry.inputMaxBytes) || entry.inputMaxBytes < 1
          || entry.inputMaxBytes > 4 * 1024 * 1024 || !Array.isArray(entry.resourceKinds)
          || entry.resourceKinds.some((kind) => typeof kind !== 'string' || kind.length < 1 || kind.length > 128)) {
          throw new OperatorError('CAPABILITY_SCHEMA_INVALID', `Provider ${provider.name} returned an invalid capability schema.`);
        }
        schemas.push({ ...structuredClone(entry), provider: provider.name });
      }
    }
    return schemas.sort((a, b) => a.provider.localeCompare(b.provider));
  }

  async initializeAll(): Promise<void> {
    for (const provider of this.#providers) await provider.initialize?.();
  }

  async emergencyStopAll(): Promise<void> {
    const results = await Promise.allSettled(this.#providers.map(async (provider) => provider.emergencyStop?.()));
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) throw rejected.reason;
  }

  async select(action: ActionRequest, learningContext = 'global'): Promise<CapabilityProvider> {
    const ranked = await this.rank(action, learningContext);
    if (!ranked[0]) {
      throw new OperatorError('CAPABILITY_UNAVAILABLE', `No provider can execute ${action.capability}.`);
    }
    return ranked[0].provider;
  }

  async closeAll(): Promise<void> {
    const providers = [...this.#providers].reverse();
    const results = await Promise.allSettled(providers.map(async (provider) => provider.close?.()));
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) throw rejected.reason;
  }
}
