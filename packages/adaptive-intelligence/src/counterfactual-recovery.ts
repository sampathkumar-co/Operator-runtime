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
  const budget = input.remainingCostBudget === undefined
    ? Number.POSITIVE_INFINITY
    : boundedNumber(input.remainingCostBudget, 0, Number.MAX_SAFE_INTEGER, 'remainingCostBudget');

  if (primary === 'AUTHORITY_DENIED' || primary === 'BUDGET_EXHAUSTED') {
    const failSafe = options.find((item) => item.kind === 'FAIL_SAFE');
    if (!failSafe) {
      throw new Error('Fail-safe recovery is mandatory for authority or budget failures.');
    }
    return decision(
      failSafe,
      options,
      'Authority/budget failure cannot be repaired by adaptive execution; execution stops safely.'
    );
  }

  if (primary === 'SIDE_EFFECT_UNCERTAIN') {
    const affordableReconcile = options.find(
      (item) => item.kind === 'RECONCILE' && fitsBudget(item, budget)
    );
    if (affordableReconcile) {
      return decision(
        affordableReconcile,
        options,
        'Uncertain mutation side effects require affordable reconciliation before any replay or alternate mutation.'
      );
    }
    const failSafe = options.find((item) => item.kind === 'FAIL_SAFE');
    if (failSafe) {
      return decision(
        failSafe,
        options,
        'Reconciliation is mandatory for uncertain side effects, but no reconciliation option fits the remaining budget; failing safe.'
      );
    }
    throw new Error('No affordable reconciliation or fail-safe recovery is available for uncertain side effects.');
  }

  const eligibleOptions = budget === Number.POSITIVE_INFINITY
    ? options
    : options.filter((option) => fitsBudget(option, budget));
  if (eligibleOptions.length === 0) {
    const failSafe = options.find((item) => item.kind === 'FAIL_SAFE');
    if (failSafe) {
      return decision(
        failSafe,
        options,
        'No normal recovery option fits the remaining cost budget; failing safe.'
      );
    }
    throw new Error('No recovery option fits the remaining cost budget.');
  }

  const probability = new Map<FailureClass, number>([
    [input.attribution.primary.class, input.attribution.primary.probability],
    ...input.attribution.alternatives.map((item) => [item.class, item.probability] as const)
  ]);

  const scored = eligibleOptions.map((option) => {
    const coveredProbability = option.resolvesHypotheses.reduce((sum, cls) => sum + (probability.get(cls) ?? 0), 0);
    const costPenalty = budget === Number.POSITIVE_INFINITY
      ? Math.min(1, option.expectedCost / 100) * 0.12
      : budget === 0
        ? 0
        : Math.min(1, option.expectedCost / budget) * 0.15;
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
    ? 'Selected recovery addresses the leading failure hypothesis while respecting the hard cost budget.'
    : 'Selected recovery maximizes expected information/success under current uncertainty without violating fail-safe or budget constraints.';
  return decision(selected, scored.map((item) => item.option), reason);
}

function fitsBudget(option: RecoveryOption, budget: number): boolean {
  return budget === Number.POSITIVE_INFINITY || option.expectedCost <= budget;
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
  if (typeof input !== 'string') throw new Error(label + ' must be a string.');
  const value = input;
  if (!value || value.length > max) throw new Error(label + ' is invalid.');
  return value;
}
function boundedNumber(input: unknown, min: number, max: number, label: string): number {
  if (typeof input !== 'number') throw new Error(label + ' must be a number.');
  const value = input;
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(label + ' is invalid.');
  return value;
}
function unit(input: unknown, label: string): number { return boundedNumber(input, 0, 1, label); }
