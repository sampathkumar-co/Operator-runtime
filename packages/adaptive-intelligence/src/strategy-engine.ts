import crypto from 'node:crypto';
import type { CausalTransition, FailureAttribution, StrategyCandidate, StrategyEvaluation } from './contracts.ts';

export interface StrategySelectionInput {
  candidates: StrategyCandidate[];
  recentTransitions?: CausalTransition[];
  failure?: FailureAttribution;
  remainingCostBudget?: number;
  explorationWeight?: number;
}

export interface StrategySelection {
  selected: StrategyEvaluation;
  ranked: StrategyEvaluation[];
  fingerprint: string;
}

export function selectStrategy(input: StrategySelectionInput): StrategySelection {
  if (!Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > 100) {
    throw new Error('Strategy candidates must contain 1-100 pre-authorized entries.');
  }
  const recent = input.recentTransitions ?? [];
  const explorationWeight = boundedNumber(input.explorationWeight ?? 0.08, 0, 0.5, 'explorationWeight');
  const remainingBudget = input.remainingCostBudget === undefined
    ? Number.POSITIVE_INFINITY
    : boundedNumber(input.remainingCostBudget, 0, Number.MAX_SAFE_INTEGER, 'remainingCostBudget');

  const normalizedCandidates = input.candidates.map(normalizeCandidate);
  const eligibleCandidates = remainingBudget === Number.POSITIVE_INFINITY
    ? normalizedCandidates
    : normalizedCandidates.filter((candidate) => candidate.expectedCost <= remainingBudget);
  if (eligibleCandidates.length === 0) {
    throw new Error('No strategy candidate fits the remaining cost budget.');
  }

  const ranked = eligibleCandidates.map((c) => {
    const equivalentFailures = Math.max(
      c.repeatedEquivalentFailures ?? 0,
      recentEquivalentFailures(c, recent)
    );
    const penalties: string[] = [];
    const costScale = remainingBudget === Number.POSITIVE_INFINITY
      ? Math.min(1, c.expectedCost / 100)
      : remainingBudget === 0
        ? 0
        : Math.min(2, c.expectedCost / remainingBudget);
    const repetitionPenalty = Math.min(0.45, equivalentFailures * 0.14);
    const uncertaintyPenalty = c.uncertainty * 0.22;
    const costPenalty = costScale * 0.12;
    const weakVerificationPenalty = (1 - c.verificationStrength) * 0.16;
    const failureAffinityPenalty = failurePenalty(c, input.failure);

    if (repetitionPenalty > 0) penalties.push('repeated-equivalent-failure');
    if (uncertaintyPenalty > 0.12) penalties.push('high-uncertainty');
    if (costPenalty > 0.08) penalties.push('budget-cost');
    if (weakVerificationPenalty > 0.08) penalties.push('weak-verification');
    if (failureAffinityPenalty > 0) penalties.push('matches-current-failure-mode');

    const unseenBonus = equivalentFailures === 0 && !recent.some((item) => item.action.family === c.family)
      ? explorationWeight
      : 0;

    const utility =
      c.expectedSuccess * 0.56
      + c.verificationStrength * 0.18
      + unseenBonus
      - uncertaintyPenalty
      - costPenalty
      - repetitionPenalty
      - weakVerificationPenalty
      - failureAffinityPenalty;

    return {
      ...c,
      repeatedEquivalentFailures: equivalentFailures,
      utility: round(utility),
      penalties
    };
  }).sort((a, b) =>
    b.utility - a.utility
    || b.expectedSuccess - a.expectedSuccess
    || a.expectedCost - b.expectedCost
    || a.id.localeCompare(b.id)
  );

  const selected = ranked[0]!;
  return {
    selected,
    ranked,
    fingerprint: strategyFingerprint(selected)
  };
}

export function strategyFingerprint(candidate: Pick<StrategyCandidate, 'family' | 'requiresFacts' | 'expectedEffects'>): string {
  const canonical = JSON.stringify({
    family: candidate.family,
    requiresFacts: [...new Set(candidate.requiresFacts ?? [])].sort(),
    expectedEffects: [...new Set(candidate.expectedEffects ?? [])].sort()
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function recentEquivalentFailures(candidate: StrategyCandidate, transitions: CausalTransition[]): number {
  const fingerprint = equivalenceFingerprint(candidate);
  let failures = 0;
  for (const transition of transitions.slice(-30)) {
    const other = equivalenceFingerprint({
      family: transition.action.family,
      expectedEffects: transition.action.expectedEffects ?? []
    });
    const failed = !transition.outcome.ok || transition.delta.expectedEffectsMissing.length > 0;
    if (failed && other === fingerprint) failures += 1;
  }
  return failures;
}

function equivalenceFingerprint(candidate: Pick<StrategyCandidate, 'family' | 'expectedEffects'>): string {
  return strategyFingerprint({
    family: candidate.family,
    requiresFacts: [],
    expectedEffects: candidate.expectedEffects ?? []
  });
}

function failurePenalty(candidate: StrategyCandidate, attribution?: FailureAttribution): number {
  if (!attribution) return 0;
  const primary = attribution.primary;
  if (primary.class === 'TARGET_STALE' || primary.class === 'TARGET_AMBIGUOUS' || primary.class === 'PERCEPTION_INCOMPLETE') {
    return candidate.family.includes('reobserve') || candidate.family.includes('reground') ? 0 : primary.probability * 0.12;
  }
  if (primary.class === 'SIDE_EFFECT_UNCERTAIN') {
    return candidate.family.includes('reconcile') ? 0 : primary.probability * 0.3;
  }
  if (primary.class === 'PROVIDER_TRANSIENT') {
    return candidate.family.includes('wait') || candidate.family.includes('health') ? 0 : primary.probability * 0.1;
  }
  if (primary.class === 'AUTHORITY_DENIED' || primary.class === 'BUDGET_EXHAUSTED') {
    return 0.5;
  }
  return 0;
}

function normalizeCandidate(input: StrategyCandidate): StrategyCandidate {
  if (!input || typeof input !== 'object') throw new Error('strategy candidate is required.');
  return {
    id: bounded(input.id, 256, 'strategy.id'),
    family: bounded(input.family, 256, 'strategy.family'),
    description: bounded(input.description, 2048, 'strategy.description'),
    expectedSuccess: unit(input.expectedSuccess, 'strategy.expectedSuccess'),
    expectedCost: boundedNumber(input.expectedCost, 0, 1_000_000_000, 'strategy.expectedCost'),
    uncertainty: unit(input.uncertainty, 'strategy.uncertainty'),
    verificationStrength: unit(input.verificationStrength, 'strategy.verificationStrength'),
    ...(input.repeatedEquivalentFailures !== undefined
      ? { repeatedEquivalentFailures: boundedInteger(input.repeatedEquivalentFailures, 0, 10_000, 'strategy.repeatedEquivalentFailures') }
      : {}),
    ...(input.requiresFacts ? { requiresFacts: [...new Set(input.requiresFacts.map((item) => bounded(item, 512, 'strategy.requiresFact')))].sort() } : {}),
    ...(input.expectedEffects ? { expectedEffects: [...new Set(input.expectedEffects.map((item) => bounded(item, 512, 'strategy.expectedEffect')))].sort() } : {})
  };
}
function bounded(input: unknown, max: number, label: string): string {
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
function unit(input: unknown, label: string): number { return boundedNumber(input, 0, 1, label); }
function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
