import type {
  BeliefResolution,
  CausalTransition,
  GoalDescriptor,
  ProgressAssessment,
  ProgressLevel
} from './contracts.ts';

export interface ProgressInput {
  goal: GoalDescriptor;
  transition: CausalTransition;
  beliefs: BeliefResolution[];
  independentVerification?: boolean;
}

export function assessProgress(input: ProgressInput): ProgressAssessment {
  const goal = normalizeGoal(input.goal);
  const beliefByKey = new Map(input.beliefs.map((item) => [item.factKey, item]));
  const satisfied = goal.successFactKeys.filter((key) => isSupported(beliefByKey.get(key)));
  const missing = goal.successFactKeys.filter((key) => !satisfied.includes(key));
  const forbidden = (goal.forbiddenFactKeys ?? []).filter((key) => isSupported(beliefByKey.get(key)));
  const creditedSignals: string[] = [];
  const rejectedSignals: string[] = [];

  const stateChanged = totalChanges(input.transition) > 0;
  const expectedProgress = input.transition.delta.expectedEffectsSatisfied.length > 0;
  const explicitProgress = input.transition.delta.progressSignals.length > 0;

  if (input.transition.outcome.ok) creditedSignals.push('provider-action-ok');
  else rejectedSignals.push('provider-action-failed');

  if (stateChanged) creditedSignals.push('durable-state-delta');
  else if (input.transition.outcome.ok) rejectedSignals.push('action-ok-without-state-delta');

  if (expectedProgress) creditedSignals.push('expected-effect-observed');
  if (explicitProgress) creditedSignals.push(...input.transition.delta.progressSignals.map((item) => 'progress:' + item));
  if (input.transition.delta.expectedEffectsMissing.length > 0) {
    rejectedSignals.push(...input.transition.delta.expectedEffectsMissing.map((item) => 'missing-effect:' + item));
  }

  let level: ProgressLevel = 'NONE';
  if (input.transition.outcome.ok) level = 'ACTION_EXECUTED';
  if (stateChanged) level = 'STATE_CHANGED';
  if (expectedProgress || explicitProgress || satisfied.length > 0) level = 'SUBGOAL_PROGRESS';

  const allGoalFacts = missing.length === 0 && goal.successFactKeys.length > 0;
  const noForbidden = forbidden.length === 0;
  const independentlyVerified = input.independentVerification === true;
  if (allGoalFacts && noForbidden && independentlyVerified) {
    level = 'GOAL_ACHIEVED';
    creditedSignals.push('independent-goal-verification');
  } else if (allGoalFacts && !independentlyVerified) {
    rejectedSignals.push('goal-facts-present-but-independent-verification-missing');
  }
  if (!noForbidden) rejectedSignals.push('forbidden-goal-fact-observed');

  let confidence = 0;
  if (level === 'ACTION_EXECUTED') confidence = 0.35;
  if (level === 'STATE_CHANGED') confidence = 0.5;
  if (level === 'SUBGOAL_PROGRESS') {
    const factConfidence = satisfied.length === 0
      ? 0.55
      : satisfied.reduce((sum, key) => sum + (beliefByKey.get(key)?.confidence ?? 0), 0) / satisfied.length;
    confidence = Math.min(0.9, Math.max(0.55, factConfidence));
  }
  if (level === 'GOAL_ACHIEVED') {
    const factConfidence = satisfied.reduce((sum, key) => sum + (beliefByKey.get(key)?.confidence ?? 0), 0) / Math.max(1, satisfied.length);
    confidence = Math.min(1, Math.max(0.9, factConfidence));
  }
  if (forbidden.length > 0) confidence = Math.min(confidence, 0.25);

  return {
    level,
    confidence: round(confidence),
    creditedSignals: unique(creditedSignals),
    rejectedSignals: unique(rejectedSignals),
    goalFactsSatisfied: satisfied,
    goalFactsMissing: missing,
    forbiddenFactsObserved: forbidden,
    verificationRequired: level !== 'GOAL_ACHIEVED'
  };
}

function isSupported(belief: BeliefResolution | undefined): boolean {
  return Boolean(belief && (belief.status === 'KNOWN' || belief.status === 'SUPPORTED') && belief.confidence >= 0.55);
}
function totalChanges(t: CausalTransition): number {
  return t.delta.changedFactKeys.length + t.delta.addedFactKeys.length + t.delta.removedFactKeys.length;
}
function normalizeGoal(input: GoalDescriptor): GoalDescriptor {
  if (!input || typeof input !== 'object') throw new Error('goal is required.');
  if (!Array.isArray(input.successFactKeys) || input.successFactKeys.length < 1 || input.successFactKeys.length > 1000) {
    throw new Error('goal.successFactKeys must contain 1-1000 facts.');
  }
  return {
    id: bounded(input.id, 256, 'goal.id'),
    kind: bounded(input.kind, 256, 'goal.kind'),
    objective: bounded(input.objective, 16_384, 'goal.objective'),
    successFactKeys: unique(input.successFactKeys.map((item) => bounded(item, 512, 'goal.successFactKey'))),
    ...(input.forbiddenFactKeys ? { forbiddenFactKeys: unique(input.forbiddenFactKeys.map((item) => bounded(item, 512, 'goal.forbiddenFactKey'))) } : {})
  };
}
function bounded(input: unknown, max: number, label: string): string {
  const value = String(input ?? '');
  if (!value || value.length > max) throw new Error(label + ' is invalid.');
  return value;
}
function unique(values: string[]): string[] { return [...new Set(values)].sort(); }
function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
