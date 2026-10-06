import type {
  EvidenceRef,
  FailureAttribution,
  FailureClass,
  FailureHypothesis,
  ProgressAssessment,
  TrajectoryStep
} from './contracts.ts';

const FAILURE_CLASSES = new Set<FailureClass>([
  'PERCEPTION_INCOMPLETE',
  'TARGET_AMBIGUOUS',
  'TARGET_STALE',
  'GEOMETRY_INVALID',
  'ACTION_CONTRACT_REJECTED',
  'ACTION_NO_EFFECT',
  'SIDE_EFFECT_UNCERTAIN',
  'GOAL_PROGRESS_FALSE_POSITIVE',
  'PLANNER_STRATEGY_WRONG',
  'MODEL_REASONING_WRONG',
  'PROVIDER_TRANSIENT',
  'RESOURCE_CONTENTION',
  'STATE_CHANGED_EXTERNALLY',
  'VERIFICATION_INSUFFICIENT',
  'AUTHORITY_DENIED',
  'BUDGET_EXHAUSTED',
  'UNKNOWN'
]);

const PROGRESS_LEVELS = new Set([
  'NONE',
  'ACTION_EXECUTED',
  'STATE_CHANGED',
  'SUBGOAL_PROGRESS',
  'GOAL_ACHIEVED'
]);

export function validateStoredTrajectoryAdvisory(step: TrajectoryStep): void {
  if (!step || typeof step !== 'object') throw new Error('trajectory step is invalid.');
  validateProgress(step.progress);
  if (step.failure !== undefined) validateFailure(step.failure);
}

function validateProgress(input: ProgressAssessment): void {
  if (!input || typeof input !== 'object') throw new Error('trajectory progress is invalid.');
  if (!PROGRESS_LEVELS.has(input.level)) throw new Error('trajectory progress level is invalid.');
  unit(input.confidence, 'trajectory progress confidence');
  const credited = strings(input.creditedSignals, 10_000, 1024, 'creditedSignals');
  const rejected = strings(input.rejectedSignals, 10_000, 1024, 'rejectedSignals');
  const satisfied = strings(input.goalFactsSatisfied, 10_000, 512, 'goalFactsSatisfied');
  const missing = strings(input.goalFactsMissing, 10_000, 512, 'goalFactsMissing');
  const forbidden = strings(input.forbiddenFactsObserved, 10_000, 512, 'forbiddenFactsObserved');
  if (typeof input.verificationRequired !== 'boolean') throw new Error('trajectory verificationRequired must be boolean.');

  assertDisjoint(credited, rejected, 'credited and rejected progress signals');
  assertDisjoint(satisfied, missing, 'satisfied and missing goal facts');

  if (input.level === 'GOAL_ACHIEVED') {
    if (input.verificationRequired) throw new Error('GOAL_ACHIEVED cannot require further verification.');
    if (missing.length > 0) throw new Error('GOAL_ACHIEVED cannot retain missing goal facts.');
    if (forbidden.length > 0) throw new Error('GOAL_ACHIEVED cannot contain forbidden facts.');
  } else if (!input.verificationRequired) {
    throw new Error('Non-final progress must remain verification-required.');
  }
}

function validateFailure(input: FailureAttribution): void {
  if (!input || typeof input !== 'object') throw new Error('trajectory failure attribution is invalid.');
  const primary = validateHypothesis(input.primary, 'primary failure hypothesis');
  if (!Array.isArray(input.alternatives) || input.alternatives.length > 100) {
    throw new Error('failure alternatives are invalid.');
  }
  const alternatives = input.alternatives.map((item, index) =>
    validateHypothesis(item, 'failure alternative ' + index)
  );
  unit(input.entropy, 'failure entropy');
  unit(input.evidenceCoverage, 'failure evidence coverage');

  const all = [primary, ...alternatives];
  const classes = new Set<FailureClass>();
  let total = 0;
  for (const hypothesis of all) {
    if (classes.has(hypothesis.class)) throw new Error('failure hypothesis classes must be unique.');
    classes.add(hypothesis.class);
    total += hypothesis.probability;
  }
  if (Math.abs(total - 1) > 0.0001) throw new Error('failure hypothesis probabilities must sum to one.');
  if (alternatives.some((item) => item.probability > primary.probability + 0.000001)) {
    throw new Error('primary failure hypothesis must have highest probability.');
  }
  if (all.length === 1 && input.entropy !== 0) {
    throw new Error('single-hypothesis failure entropy must be zero.');
  }
}

function validateHypothesis(input: FailureHypothesis, label: string): FailureHypothesis {
  if (!input || typeof input !== 'object') throw new Error(label + ' is invalid.');
  if (!FAILURE_CLASSES.has(input.class)) throw new Error(label + ' class is invalid.');
  const probability = unit(input.probability, label + ' probability');
  const reasons = strings(input.reasons, 100, 4096, label + ' reasons');
  if (reasons.length === 0) throw new Error(label + ' requires a reason.');
  if (!Array.isArray(input.evidence) || input.evidence.length > 10_000) {
    throw new Error(label + ' evidence is invalid.');
  }
  const evidence = input.evidence.map((item) => validateEvidence(item));
  if (input.discriminatingObservation !== undefined) {
    bounded(input.discriminatingObservation, 4096, label + ' discriminatingObservation');
  }
  return { ...input, probability, reasons, evidence };
}

function validateEvidence(input: EvidenceRef): EvidenceRef {
  if (!input || typeof input !== 'object') throw new Error('failure evidence is invalid.');
  const digest = sha256(input.digest, 'failure evidence digest');
  return {
    digest,
    source: bounded(input.source, 256, 'failure evidence source'),
    observedAt: validIso(input.observedAt, 'failure evidence observedAt'),
    ...(input.channel !== undefined ? { channel: bounded(input.channel, 128, 'failure evidence channel') } : {}),
    ...(input.scope !== undefined ? { scope: bounded(input.scope, 512, 'failure evidence scope') } : {}),
    ...(input.independenceKey !== undefined
      ? { independenceKey: bounded(input.independenceKey, 512, 'failure evidence independenceKey') }
      : {})
  };
}

function strings(input: string[], maxItems: number, maxLength: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > maxItems) throw new Error(label + ' is invalid.');
  const values = input.map((item) => bounded(item, maxLength, label));
  if (new Set(values).size !== values.length) throw new Error(label + ' must not contain duplicates.');
  return values;
}

function assertDisjoint(a: string[], b: string[], label: string): void {
  const set = new Set(a);
  if (b.some((item) => set.has(item))) throw new Error(label + ' must be disjoint.');
}

function unit(input: unknown, label: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0 || input > 1) {
    throw new Error(label + ' must be between 0 and 1.');
  }
  return input;
}

function bounded(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || !input || input.length > max) throw new Error(label + ' is invalid.');
  return input;
}

function sha256(input: unknown, label: string): string {
  const value = bounded(input, 64, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(label + ' must be SHA-256.');
  return value;
}

function validIso(input: unknown, label: string): string {
  const value = bounded(input, 64, label);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(label + ' must be ISO timestamp.');
  }
  return value;
}
