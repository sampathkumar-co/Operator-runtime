import type {
  FailureAttribution,
  FailureClass,
  RecoveryDecision,
  RecoveryOption
} from './contracts.ts';

export interface RecoverySelectionInput {
  attribution: FailureAttribution;
  options: RecoveryOption[];
  remainingCostBudget?: number;
}

export function selectRecovery(input: RecoverySelectionInput): RecoveryDecision {
  if (!Array.isArray(input.options) || input.options.length < 1 || input.options.length > 100) {
    throw new Error('Recovery options must contain 1-100 entries.');
  }
  const options = input.options.map(normalizeOption);
  const primary = input.attribution.primary.class;

  if (primary === 'AUTHORITY_DENIED' || primary === 'BUDGET_EXHAUSTED') {
    const failSafe = options.find((item) => item.kind === 'FAIL_SAFE');
    if (failSafe) return decision(failSafe, options, 'Authority/budget failure cannot be repaired by adaptive execution.');
  }

  if (primary === 'SIDE_EFFECT_UNCERTAIN') {
    const reconcile = options.find((item) => item.kind === 'RECONCILE');
    if (reconcile) return decision(reconcile, options, 'Uncertain mutation side effects require reconciliation before any replay or alternate mutation.');
  }

  const budget = input.remainingCostBudget === undefined
    ? Number.POSITIVE_INFINITY
    : boundedNumber(input.remainingCostBudget, 0, Number.MAX_SAFE_INTEGER, 'remainingCostBudget');

  const probability = new Map<FailureClass, number>([
    [input.attribution.primary.class, input.attribution.primary.probability],
    ...input.attribution.alternatives.map((item) => [item.class, item.probability] as const)
  ]);

  const scored = options.map((option) => {
    const coveredProbability = option.resolvesHypotheses.reduce((sum, cls) => sum + (probability.get(cls) ?? 0), 0);
    const costPenalty = budget === Number.POSITIVE_INFINITY || budget === 0
      ? Math.min(1, option.expectedCost / 100) * 0.12
      : Math.min(2, option.expectedCost / Math.max(1, budget)) * 0.15;
    const infoTerm = option.expectedInformationGain * (0.25 + input.attribution.entropy * 0.2);
    const score =
      option.expectedSuccess * 0.42
      + infoTerm
      + Math.min(1, coveredProbability) * 0.28
      - option.risk * 0.38
      - costPenalty;
    return { option, score };
  }).sort((a, b) =>
    b.score - a.score
    || b.option.expectedInformationGain - a.option.expectedInformationGain
    || a.option.expectedCost - b.option.expectedCost
    || a.option.id.localeCompare(b.option.id)
  );

  const selected = scored[0]!.option;
  const reason = selected.resolvesHypotheses.includes(primary)
    ? 'Selected recovery addresses the leading failure hypothesis while balancing information gain, cost, and risk.'
    : 'Selected recovery maximizes expected information/success under current uncertainty without violating fail-safe constraints.';
  return decision(selected, scored.map((item) => item.option), reason);
}

function decision(selected: RecoveryOption, options: RecoveryOption[], reason: string): RecoveryDecision {
  return {
    selected,
    alternatives: options.filter((item) => item.id !== selected.id),
    reason
  };
}

function normalizeOption(input: RecoveryOption): RecoveryOption {
  if (!input || typeof input !== 'object') throw new Error('recovery option is required.');
  const kinds = new Set(['REOBSERVE','REGROUND','REPLAN','REPAIR','RECONCILE','WAIT','VERIFY','FAIL_SAFE']);
  if (!kinds.has(input.kind)) throw new Error('recovery.kind is invalid.');
  if (!Array.isArray(input.resolvesHypotheses) || input.resolvesHypotheses.length > 50) throw new Error('recovery.resolvesHypotheses is invalid.');
  return {
    id: bounded(input.id, 256, 'recovery.id'),
    kind: input.kind,
    description: bounded(input.description, 2048, 'recovery.description'),
    expectedInformationGain: unit(input.expectedInformationGain, 'recovery.expectedInformationGain'),
    expectedSuccess: unit(input.expectedSuccess, 'recovery.expectedSuccess'),
    expectedCost: boundedNumber(input.expectedCost, 0, 1_000_000_000, 'recovery.expectedCost'),
    risk: unit(input.risk, 'recovery.risk'),
    resolvesHypotheses: [...new Set(input.resolvesHypotheses)]
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
