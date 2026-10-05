import crypto from 'node:crypto';
import type { ActionDescriptor, ActionOutcome, CausalTransition, StateDelta, StateFact, StateSnapshot } from './contracts.ts';

export class CausalGraph {
  #transitions: CausalTransition[] = [];
  #maxTransitions: number;
  #clock: () => Date;

  constructor(options: { maxTransitions?: number; clock?: () => Date } = {}) {
    this.#maxTransitions = boundedInteger(options.maxTransitions ?? 10_000, 1, 100_000, 'maxTransitions');
    this.#clock = options.clock ?? (() => new Date());
  }

  record(input: {
    before: StateSnapshot;
    action: ActionDescriptor;
    outcome: ActionOutcome;
    after: StateSnapshot;
    progressSignals?: string[];
  }): CausalTransition {
    const before = normalizeSnapshot(input.before);
    const after = normalizeSnapshot(input.after);
    const action = normalizeAction(input.action);
    const outcome = normalizeOutcome(input.outcome);
    const delta = deriveDelta(before, after, action.expectedEffects ?? [], input.progressSignals ?? []);
    const causalConfidence = causalConfidenceFor(action, outcome, delta, before, after);
    const transition: CausalTransition = {
      id: crypto.randomUUID(),
      before,
      action,
      outcome,
      after,
      delta,
      causalConfidence,
      recordedAt: this.#clock().toISOString()
    };
    this.#transitions.push(transition);
    if (this.#transitions.length > this.#maxTransitions) {
      this.#transitions.splice(0, this.#transitions.length - this.#maxTransitions);
    }
    return structuredClone(transition);
  }

  recent(limitInput = 100): CausalTransition[] {
    const limit = boundedInteger(limitInput, 1, 1000, 'limit');
    return this.#transitions.slice(-limit).reverse().map((item) => structuredClone(item));
  }

  byActionFamily(familyInput: string, limitInput = 100): CausalTransition[] {
    const family = boundedText(familyInput, 256, 'family');
    const limit = boundedInteger(limitInput, 1, 1000, 'limit');
    return this.#transitions
      .filter((item) => item.action.family === family)
      .slice(-limit)
      .reverse()
      .map((item) => structuredClone(item));
  }

  equivalentFailureCount(familyInput: string, expectedEffects: string[] = [], window = 20): number {
    const family = boundedText(familyInput, 256, 'family');
    const expected = new Set(expectedEffects);
    return this.#transitions
      .slice(-boundedInteger(window, 1, 1000, 'window'))
      .filter((item) => item.action.family === family)
      .filter((item) => !item.outcome.ok || item.delta.expectedEffectsMissing.some((effect) => expected.size === 0 || expected.has(effect)))
      .length;
  }
}

export function deriveDelta(
  before: StateSnapshot,
  after: StateSnapshot,
  expectedEffects: string[],
  progressSignals: string[]
): StateDelta {
  const a = new Map(before.facts.map((fact) => [fact.key, fact]));
  const b = new Map(after.facts.map((fact) => [fact.key, fact]));
  const changedFactKeys: string[] = [];
  const addedFactKeys: string[] = [];
  const removedFactKeys: string[] = [];

  for (const [key, next] of b) {
    const prev = a.get(key);
    if (!prev) addedFactKeys.push(key);
    else if (prev.valueDigest !== next.valueDigest) changedFactKeys.push(key);
  }
  for (const key of a.keys()) if (!b.has(key)) removedFactKeys.push(key);

  const changed = new Set([...changedFactKeys, ...addedFactKeys, ...removedFactKeys]);
  const expectedEffectsSatisfied = expectedEffects.filter((effect) => changed.has(effect));
  const expectedEffectsMissing = expectedEffects.filter((effect) => !changed.has(effect));
  const expectedSet = new Set(expectedEffects);
  const unrelatedEffects = [...changed].filter((key) => !expectedSet.has(key));

  return {
    changedFactKeys: changedFactKeys.sort(),
    addedFactKeys: addedFactKeys.sort(),
    removedFactKeys: removedFactKeys.sort(),
    expectedEffectsSatisfied: [...new Set(expectedEffectsSatisfied)].sort(),
    expectedEffectsMissing: [...new Set(expectedEffectsMissing)].sort(),
    unrelatedEffects: unrelatedEffects.sort(),
    progressSignals: [...new Set(progressSignals.map((item) => boundedText(item, 512, 'progressSignal')))].sort()
  };
}

function causalConfidenceFor(
  action: ActionDescriptor,
  outcome: ActionOutcome,
  delta: StateDelta,
  before: StateSnapshot,
  after: StateSnapshot
): number {
  if (!outcome.ok && outcome.sideEffectState === 'none') return 0.05;
  if (outcome.sideEffectState === 'uncertain') return 0.25;
  let score = outcome.ok ? 0.35 : 0.15;
  if (delta.expectedEffectsSatisfied.length > 0) score += 0.35;
  if (delta.expectedEffectsMissing.length === 0 && (action.expectedEffects?.length ?? 0) > 0) score += 0.15;
  if (delta.unrelatedEffects.length > delta.expectedEffectsSatisfied.length + 2) score -= 0.15;
  if (before.stateVersion && after.stateVersion && before.stateVersion === after.stateVersion) score -= 0.2;
  if (Date.parse(after.observedAt) < Date.parse(before.observedAt)) score -= 0.25;
  return clamp01(score);
}

function normalizeSnapshot(input: StateSnapshot): StateSnapshot {
  if (!input || typeof input !== 'object') throw new Error('state snapshot is required.');
  const facts = Array.isArray(input.facts) ? input.facts.map(normalizeFact) : [];
  const keys = new Set<string>();
  for (const fact of facts) {
    if (keys.has(fact.key)) throw new Error('state snapshot fact keys must be unique.');
    keys.add(fact.key);
  }
  return {
    id: boundedText(input.id, 256, 'snapshot.id'),
    observedAt: validIso(input.observedAt, 'snapshot.observedAt'),
    scopeKey: boundedText(input.scopeKey, 512, 'snapshot.scopeKey'),
    ...(input.stateVersion ? { stateVersion: boundedText(input.stateVersion, 512, 'snapshot.stateVersion') } : {}),
    facts: facts.sort((a, b) => a.key.localeCompare(b.key))
  };
}

function normalizeFact(input: StateFact): StateFact {
  return {
    key: boundedText(input.key, 512, 'fact.key'),
    valueDigest: sha256(input.valueDigest, 'fact.valueDigest'),
    confidence: unit(input.confidence, 'fact.confidence'),
    evidence: Array.isArray(input.evidence) ? structuredClone(input.evidence) : []
  };
}

function normalizeAction(input: ActionDescriptor): ActionDescriptor {
  if (!input || typeof input !== 'object') throw new Error('action is required.');
  if (!['read','write','execute','network','unknown'].includes(input.risk)) throw new Error('action.risk is invalid.');
  return {
    id: boundedText(input.id, 512, 'action.id'),
    family: boundedText(input.family, 256, 'action.family'),
    capability: boundedText(input.capability, 256, 'action.capability'),
    risk: input.risk,
    ...(input.semanticTarget ? { semanticTarget: boundedText(input.semanticTarget, 512, 'action.semanticTarget') } : {}),
    ...(input.strategyId ? { strategyId: boundedText(input.strategyId, 256, 'action.strategyId') } : {}),
    ...(input.expectedEffects ? { expectedEffects: [...new Set(input.expectedEffects.map((item) => boundedText(item, 512, 'expectedEffect')))].sort() } : {})
  };
}

function normalizeOutcome(input: ActionOutcome): ActionOutcome {
  if (!input || typeof input !== 'object' || typeof input.ok !== 'boolean') throw new Error('action outcome is invalid.');
  return {
    ok: input.ok,
    ...(input.provider ? { provider: boundedText(input.provider, 256, 'outcome.provider') } : {}),
    ...(input.durationMs !== undefined ? { durationMs: boundedNumber(input.durationMs, 0, 86_400_000, 'outcome.durationMs') } : {}),
    ...(input.errorCode ? { errorCode: boundedText(input.errorCode, 256, 'outcome.errorCode') } : {}),
    ...(input.sideEffectState ? { sideEffectState: input.sideEffectState } : {}),
    ...(input.executionPhase ? { executionPhase: input.executionPhase } : {}),
    evidence: Array.isArray(input.evidence) ? structuredClone(input.evidence) : []
  };
}

function boundedText(input: unknown, max: number, label: string): string {
  const value = String(input ?? '');
  if (!value || value.length > max) throw new Error(label + ' is invalid.');
  return value;
}
function boundedNumber(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(label + ' is invalid.');
  return value;
}
function boundedInteger(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(label + ' is invalid.');
  return value;
}
function unit(input: unknown, label: string): number {
  return boundedNumber(input, 0, 1, label);
}
function sha256(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(label + ' must be SHA-256.');
  return value;
}
function validIso(input: unknown, label: string): string {
  const value = String(input ?? '');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(label + ' must be ISO timestamp.');
  return value;
}
function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
