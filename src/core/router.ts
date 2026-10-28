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

export async function providerSupports(provider: CapabilityProvider, action: ActionRequest): Promise<boolean> {
  const supported = await provider.supports(action);
  if (typeof supported !== 'boolean') {
    throw new OperatorError('PROVIDER_SUPPORT_CONTRACT_INVALID',
      `Provider ${provider.name} returned a non-boolean supports() declaration.`, {
        retryable: false,
        details: { executionPhase: 'pre_dispatch', sideEffectState: 'none' }
      });
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
  const invalid = (): never => {
    throw new OperatorError('PROVIDER_SCORE_CONTRACT_INVALID',
      `Provider ${providerName} returned an invalid capability score.`);
  };
  if (!score || typeof score !== 'object' || Array.isArray(score) ||
      (Object.getPrototypeOf(score) !== Object.prototype &&
       Object.getPrototypeOf(score) !== null)) return invalid();
  // Read each immutable data descriptor only once. Provider score callbacks
  // must not install getters which run again when the rank is calculated.
  const result: Record<string, number> = {};
  const fields = Reflect.ownKeys(score);
  const allowed = Object.keys(WEIGHTS);
  if (fields.length !== allowed.length ||
      fields.some(key => typeof key !== 'string' || !allowed.includes(key))) return invalid();
  for (const key of allowed) {
    const prop = Object.getOwnPropertyDescriptor(score, key);
    if (!prop || !prop.enumerable || !('value' in prop) ||
        typeof prop.value !== 'number' || !Number.isFinite(prop.value)) return invalid();
    result[key] = prop.value;
  }
  return result as unknown as CapabilityScore;
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
    // Provider names are reconciliation identities. Two instances with one name
    // can select one implementation and later reconcile against another.
    if (!provider || typeof provider.name !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(provider.name) ||
        typeof provider.supports !== 'function' ||
        typeof provider.score !== 'function' ||
        typeof provider.execute !== 'function' ||
        this.#providers.some((existing) => existing.name === provider.name)) {
      throw new OperatorError('PROVIDER_REGISTRY_INVALID',
        'Provider registration requires a unique bounded identity and valid execution contract.');
    }
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
      const invalid = (): never => {
        throw new OperatorError('CAPABILITY_SCHEMA_INVALID',
          `Provider ${provider.name} returned an invalid capability schema collection.`);
      };
      const declarations = provider.capabilitySchemas();
      if (!Array.isArray(declarations) || declarations.length > 256 ||
          Object.getPrototypeOf(declarations) !== Array.prototype ||
          Reflect.ownKeys(declarations).length !== declarations.length + 1) return invalid();
      const seen = new Set<string>();
      for (let index = 0; index < declarations.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(declarations, String(index));
        const raw = descriptor?.value;
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor) ||
            !raw || typeof raw !== 'object' || Array.isArray(raw) ||
            (Object.getPrototypeOf(raw) !== Object.prototype &&
             Object.getPrototypeOf(raw) !== null)) return invalid();
        const fields = Reflect.ownKeys(raw);
        const allowed = ['capability','risk','inputSchemaVersion','inputMaxBytes','cancellation','resourceKinds'];
        if (fields.length !== allowed.length ||
            fields.some(key => typeof key !== 'string' || !allowed.includes(key))) return invalid();
        const value: Record<string, unknown> = {};
        for (const key of allowed) {
          const field = Object.getOwnPropertyDescriptor(raw, key);
          if (!field || !field.enumerable || !('value' in field)) return invalid();
          value[key] = field.value;
        }
        const capability = value.capability;
        if (typeof capability !== 'string' ||
            !/^[A-Za-z][A-Za-z0-9._:-]{0,255}$/.test(capability) ||
            seen.has(capability)) return invalid();
        seen.add(capability);
        const kinds = value.resourceKinds;
        if (!Array.isArray(kinds) || kinds.length > 128 ||
            Object.getPrototypeOf(kinds) !== Array.prototype ||
            Reflect.ownKeys(kinds).length !== kinds.length + 1) return invalid();
        const inertKinds: string[] = [];
        for (let i = 0; i < kinds.length; i++) {
          const field = Object.getOwnPropertyDescriptor(kinds, String(i));
          if (!field || !field.enumerable || !('value' in field) ||
              typeof field.value !== 'string' || field.value.length < 1 ||
              field.value.length > 128) return invalid();
          inertKinds.push(field.value);
        }
        if (value.inputSchemaVersion !== 1 || value.cancellation !== 'required' ||
            !['read','write','external','system','destructive','dynamic'].includes(value.risk as string) ||
            !Number.isSafeInteger(value.inputMaxBytes) ||
            (value.inputMaxBytes as number) < 1 ||
            (value.inputMaxBytes as number) > 4 * 1024 * 1024) return invalid();
        if (capability === action.capability) {
          schemas.push({
            capability, risk: value.risk as ProviderCapabilitySchema['risk'],
            inputSchemaVersion: 1, inputMaxBytes: value.inputMaxBytes as number,
            cancellation: 'required', resourceKinds: inertKinds, provider: provider.name
          });
        }
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
