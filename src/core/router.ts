import type { ActionRequest, ActionRisk, CapabilityProvider, CapabilityScore } from './types.ts';
import { OperatorError } from './errors.ts';

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

function weightedScore(score: CapabilityScore): number {
  return Object.entries(WEIGHTS).reduce((total, [key, weight]) => {
    const raw = score[key as keyof CapabilityScore];
    const value = key === 'latency' || key === 'interactionCost' ? 1 - normalize(raw) : normalize(raw);
    return total + value * weight;
  }, 0);
}

export class CapabilityRouter {
  #providers: CapabilityProvider[] = [];

  register(provider: CapabilityProvider): void {
    this.#providers.push(provider);
  }

  async supports(action: ActionRequest): Promise<boolean> {
    for (const provider of this.#providers) {
      if (await provider.supports(action)) return true;
    }
    return false;
  }

  async rank(action: ActionRequest): Promise<Array<{ provider: CapabilityProvider; score: number }>> {
    const candidates: Array<{ provider: CapabilityProvider; score: number }> = [];
    for (const provider of this.#providers) {
      if (await provider.supports(action)) {
        candidates.push({ provider, score: weightedScore(await provider.score(action)) });
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.provider.name.localeCompare(b.provider.name));
    return candidates;
  }

  async resolveRisk(action: ActionRequest): Promise<ActionRisk> {
    const risks = new Set<ActionRisk>();
    for (const provider of this.#providers) {
      if (await provider.supports(action) && provider.resolveRisk) risks.add(await provider.resolveRisk(action));
    }
    if (risks.size !== 1) throw new OperatorError('CAPABILITY_RISK_UNRESOLVED', `Capability ${action.capability} does not have one trusted dynamic risk.`);
    return [...risks][0]!;
  }

  async select(action: ActionRequest): Promise<CapabilityProvider> {
    const ranked = await this.rank(action);
    if (!ranked[0]) {
      throw new OperatorError('CAPABILITY_UNAVAILABLE', `No provider can execute ${action.capability}.`);
    }
    return ranked[0].provider;
  }

  async closeAll(): Promise<void> {
    const providers = [...this.#providers].reverse();
    await Promise.allSettled(providers.map(async (provider) => provider.close?.()));
  }
}
