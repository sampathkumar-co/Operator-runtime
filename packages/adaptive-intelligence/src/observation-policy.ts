import type { BeliefResolution } from './contracts.ts';

export interface ObservationCandidate {
  id: string;
  channel: 'dom' | 'accessibility' | 'uia' | 'visual' | 'application' | 'runtime' | string;
  description: string;
  resolvesFacts: string[];
  expectedInformationGain: number;
  expectedCost: number;
  targetLocal: boolean;
  mutating?: boolean;
}

export interface ObservationEvaluation extends ObservationCandidate {
  score: number;
  relevantUncertainty: number;
  penalties: string[];
}

export interface ObservationSelection {
  selected: ObservationEvaluation;
  ranked: ObservationEvaluation[];
}

export function selectObservation(
  beliefs: BeliefResolution[],
  candidatesInput: ObservationCandidate[],
  options: { remainingCostBudget?: number } = {}
): ObservationSelection {
  if (!Array.isArray(candidatesInput) || candidatesInput.length < 1 || candidatesInput.length > 100) {
    throw new Error('observation candidates must contain 1-100 entries.');
  }
  const unresolved = new Map(beliefs.map((belief) => [belief.factKey, uncertaintyWeight(belief)]));
  const budget = options.remainingCostBudget === undefined
    ? Number.POSITIVE_INFINITY
    : boundedNumber(options.remainingCostBudget, 0, Number.MAX_SAFE_INTEGER, 'remainingCostBudget');

  const normalizedCandidates = candidatesInput.map(normalizeCandidate);
  if (normalizedCandidates.some((candidate) => candidate.mutating)) {
    throw new Error('Adaptive observation policy accepts read-only observation candidates only.');
  }
  const eligibleCandidates = budget === Number.POSITIVE_INFINITY
    ? normalizedCandidates
    : normalizedCandidates.filter((candidate) => candidate.expectedCost <= budget);
  if (eligibleCandidates.length === 0) {
    throw new Error('No read-only observation candidate fits the remaining cost budget.');
  }

  const ranked = eligibleCandidates.map((candidate) => {
    const relevantUncertainty = candidate.resolvesFacts.reduce((sum, fact) => sum + (unresolved.get(fact) ?? 0), 0);
    const structureBonus = channelPriority(candidate.channel) * 0.12;
    const localBonus = candidate.targetLocal ? 0.08 : 0;
    const costPenalty = budget === Number.POSITIVE_INFINITY
      ? Math.min(1, candidate.expectedCost / 100) * 0.12
      : budget === 0
        ? 0
        : Math.min(2, candidate.expectedCost / budget) * 0.15;
    const irrelevantPenalty = relevantUncertainty === 0 ? 0.25 : 0;
    const fullVisualPenalty = candidate.channel === 'visual' && !candidate.targetLocal ? 0.08 : 0;
    const score =
      candidate.expectedInformationGain * 0.48
      + Math.min(1, relevantUncertainty) * 0.35
      + structureBonus
      + localBonus
      - costPenalty
      - irrelevantPenalty
      - fullVisualPenalty;
    const penalties: string[] = [];
    if (irrelevantPenalty) penalties.push('does-not-resolve-current-uncertainty');
    if (fullVisualPenalty) penalties.push('whole-scene-visual-cost');
    if (costPenalty > 0.08) penalties.push('budget-cost');
    return {
      ...candidate,
      score: round(score),
      relevantUncertainty: round(relevantUncertainty),
      penalties
    };
  }).sort((a, b) =>
    b.score - a.score
    || b.relevantUncertainty - a.relevantUncertainty
    || channelPriority(b.channel) - channelPriority(a.channel)
    || a.expectedCost - b.expectedCost
    || a.id.localeCompare(b.id)
  );

  return { selected: ranked[0]!, ranked };
}

function uncertaintyWeight(belief: BeliefResolution): number {
  if (belief.status === 'CONFLICTED') return 1;
  if (belief.status === 'UNKNOWN' || belief.status === 'UNOBSERVABLE') return 0.9;
  if (belief.status === 'STALE') return 0.8;
  if (belief.status === 'SUPPORTED') return Math.max(0.1, 1 - belief.confidence);
  if (belief.status === 'DISPROVEN') return 0.15;
  return Math.max(0, 1 - belief.confidence) * 0.25;
}

function channelPriority(channel: string): number {
  if (channel === 'dom') return 1;
  if (channel === 'accessibility' || channel === 'uia') return 0.95;
  if (channel === 'application' || channel === 'runtime') return 0.9;
  if (channel === 'visual') return 0.65;
  return 0.5;
}

function normalizeCandidate(input: ObservationCandidate): ObservationCandidate {
  if (!input || typeof input !== 'object') throw new Error('observation candidate is required.');
  return {
    id: bounded(input.id, 256, 'observation.id'),
    channel: bounded(input.channel, 128, 'observation.channel'),
    description: bounded(input.description, 2048, 'observation.description'),
    resolvesFacts: [...new Set(input.resolvesFacts.map((item) => bounded(item, 512, 'observation.resolvesFact')))].sort(),
    expectedInformationGain: unit(input.expectedInformationGain, 'observation.expectedInformationGain'),
    expectedCost: boundedNumber(input.expectedCost, 0, 1_000_000_000, 'observation.expectedCost'),
    targetLocal: Boolean(input.targetLocal),
    ...(input.mutating !== undefined ? { mutating: Boolean(input.mutating) } : {})
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
function unit(input: unknown, label: string): number { return boundedNumber(input, 0, 1, label); }
function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
