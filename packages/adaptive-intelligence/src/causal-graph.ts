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

  static fromState(
    transitionsInput: CausalTransition[],
    options: { maxTransitions?: number; clock?: () => Date } = {}
  ): CausalGraph {
    if (!Array.isArray(transitionsInput) || transitionsInput.length > 100_000) throw new Error('causal graph snapshot is invalid.');
    const graph = new CausalGraph(options);
    if (transitionsInput.length > graph.#maxTransitions) throw new Error('Causal graph snapshot exceeds configured capacity.');

    const ids = new Set<string>();
    for (const raw of transitionsInput) {
      if (!raw || typeof raw !== 'object') throw new Error('Stored causal transition is invalid.');
      const id = uuid(raw.id, 'transition.id');
      if (ids.has(id)) throw new Error('Causal graph snapshot contains duplicate transition ids.');
      ids.add(id);

      const before = normalizeSnapshot(raw.before);
      const after = normalizeSnapshot(raw.after);
      const action = normalizeAction(raw.action);
      const outcome = normalizeOutcome(raw.outcome);
      const progressSignals = normalizeProgressSignals(raw.delta?.progressSignals ?? []);
      const delta = deriveDelta(before, after, action.expectedEffects ?? [], progressSignals);
      const storedDelta = normalizeStoredDelta(raw.delta);
      if (!sameDelta(delta, storedDelta)) throw new Error('Stored causal transition delta does not match state evidence.');
      const causalConfidence = causalConfidenceFor(action, outcome, delta, before, after);
      const storedConfidence = unit(raw.causalConfidence, 'transition.causalConfidence');
      if (Math.abs(causalConfidence - storedConfidence) > 1e-9) {
        throw new Error('Stored causal confidence does not match deterministic transition evidence.');
      }

      graph.#transitions.push({
        id,
        before,
        action,
        outcome,
        after,
        delta,
        causalConfidence: storedConfidence,
        recordedAt: validIso(raw.recordedAt, 'transition.recordedAt')
      });
    }
    return graph;
  }

  exportState(): CausalTransition[] {
    return structuredClone(this.#transitions);
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
    if (Date.parse(after.observedAt) < Date.parse(before.observedAt)) {
      throw new Error('Causal transition after snapshot cannot predate before snapshot.');
    }
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
    progressSignals: normalizeProgressSignals(progressSignals)
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
    evidence: Array.isArray(input.evidence) ? normalizeEvidenceList(input.evidence) : []
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
  if (input.sideEffectState !== undefined && !['none','known','uncertain'].includes(input.sideEffectState)) {
    throw new Error('outcome.sideEffectState is invalid.');
  }
  if (input.executionPhase !== undefined && !['pre_dispatch','dispatching','effect_observed','unknown'].includes(input.executionPhase)) {
    throw new Error('outcome.executionPhase is invalid.');
  }
  return {
    ok: input.ok,
    ...(input.provider ? { provider: boundedText(input.provider, 256, 'outcome.provider') } : {}),
    ...(input.durationMs !== undefined ? { durationMs: boundedNumber(input.durationMs, 0, 86_400_000, 'outcome.durationMs') } : {}),
    ...(input.errorCode ? { errorCode: boundedText(input.errorCode, 256, 'outcome.errorCode') } : {}),
    ...(input.sideEffectState ? { sideEffectState: input.sideEffectState } : {}),
    ...(input.executionPhase ? { executionPhase: input.executionPhase } : {}),
    evidence: Array.isArray(input.evidence) ? normalizeEvidenceList(input.evidence) : []
  };
}

function normalizeEvidenceList(items: import('./contracts.ts').EvidenceRef[]): import('./contracts.ts').EvidenceRef[] {
  const byDigest = new Map<string, import('./contracts.ts').EvidenceRef>();
  for (const item of items) {
    if (!item || typeof item !== 'object') throw new Error('evidence item is invalid.');
    const digest = sha256(item.digest, 'evidence.digest');
    const normalized = {
      digest,
      source: boundedText(item.source, 256, 'evidence.source'),
      observedAt: validIso(item.observedAt, 'evidence.observedAt'),
      ...(item.channel ? { channel: boundedText(item.channel, 128, 'evidence.channel') } : {}),
      ...(item.scope ? { scope: boundedText(item.scope, 512, 'evidence.scope') } : {}),
      ...(item.independenceKey ? { independenceKey: boundedText(item.independenceKey, 512, 'evidence.independenceKey') } : {})
    };
    const prior = byDigest.get(digest);
    if (prior && JSON.stringify(prior) !== JSON.stringify(normalized)) {
      throw new Error('Conflicting evidence metadata for the same digest is rejected.');
    }
    byDigest.set(digest, normalized);
  }
  return [...byDigest.values()].sort((a,b)=>b.observedAt.localeCompare(a.observedAt)||a.digest.localeCompare(b.digest));
}

function normalizeStoredDelta(input: StateDelta): StateDelta {
  if (!input || typeof input !== 'object') throw new Error('transition.delta is invalid.');
  return {
    changedFactKeys: normalizeKeys(input.changedFactKeys, 'changedFactKeys'),
    addedFactKeys: normalizeKeys(input.addedFactKeys, 'addedFactKeys'),
    removedFactKeys: normalizeKeys(input.removedFactKeys, 'removedFactKeys'),
    expectedEffectsSatisfied: normalizeKeys(input.expectedEffectsSatisfied, 'expectedEffectsSatisfied'),
    expectedEffectsMissing: normalizeKeys(input.expectedEffectsMissing, 'expectedEffectsMissing'),
    unrelatedEffects: normalizeKeys(input.unrelatedEffects, 'unrelatedEffects'),
    progressSignals: normalizeProgressSignals(input.progressSignals)
  };
}
function normalizeKeys(input: string[], label: string): string[] {
  if (!Array.isArray(input) || input.length > 100_000) throw new Error(label + ' is invalid.');
  return [...new Set(input.map((item) => boundedText(item, 512, label)))].sort();
}
function normalizeProgressSignals(input: string[]): string[] {
  if (!Array.isArray(input) || input.length > 10_000) throw new Error('progressSignals is invalid.');
  return [...new Set(input.map((item) => boundedText(item, 512, 'progressSignal')))].sort();
}
function sameDelta(a: StateDelta, b: StateDelta): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function uuid(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error(label + ' must be a UUID.');
  }
  return value;
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
