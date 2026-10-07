import type {
  BeliefResolution,
  CompressedTrajectory,
  EvidenceRef,
  FailureHypothesis,
  GoalDescriptor,
  ProgressLevel,
  TrajectoryStep
} from './contracts.ts';
import { strategyFingerprint } from './strategy-engine.ts';

export interface TrajectoryCompressionInput {
  goal: GoalDescriptor;
  steps: TrajectoryStep[];
  beliefs: BeliefResolution[];
  maxRecentStrategies?: number;
  maxHypotheses?: number;
  maxEvidence?: number;
}

export function compressTrajectory(input: TrajectoryCompressionInput): CompressedTrajectory {
  if (!Array.isArray(input.steps) || input.steps.length > 100_000) throw new Error('steps is invalid.');
  const goalId = bounded(input.goal.id, 256, 'goal.id');
  const maxRecent = integer(input.maxRecentStrategies ?? 12, 1, 100, 'maxRecentStrategies');
  const maxHypotheses = integer(input.maxHypotheses ?? 8, 1, 50, 'maxHypotheses');
  const maxEvidence = integer(input.maxEvidence ?? 32, 1, 256, 'maxEvidence');

  const verifiedFacts: string[] = [];
  const unresolvedFacts: string[] = [];
  for (const belief of input.beliefs) {
    if (belief.status === 'KNOWN' || (belief.status === 'SUPPORTED' && belief.confidence >= 0.7)) verifiedFacts.push(belief.factKey);
    else if (['UNKNOWN','STALE','CONFLICTED','UNOBSERVABLE'].includes(belief.status)) unresolvedFacts.push(belief.factKey);
  }

  const failedAssumptions = new Set<string>();
  const hypothesisScores = new Map<string, { hypothesis: FailureHypothesis; score: number }>();
  const strategyFailures = new Map<string, { family: string; count: number }>();
  const recentStrategies: string[] = [];
  const evidence: EvidenceRef[] = [];

  for (const step of input.steps) {
    const strategy = step.action.strategyId ?? step.action.family;
    recentStrategies.push(strategy);
    evidence.push(...step.outcome.evidence);
    const stepFailed = Boolean(step.failure) || !step.outcome.ok || step.delta.expectedEffectsMissing.length > 0;
    if (step.failure) {
      const hypotheses = [step.failure.primary, ...step.failure.alternatives];
      for (const hypothesis of hypotheses) {
        const existing = hypothesisScores.get(hypothesis.class);
        const score = hypothesis.probability * (step.index + 1);
        if (!existing || score > existing.score) {
          hypothesisScores.set(hypothesis.class, { hypothesis: structuredClone(hypothesis), score });
        }
        evidence.push(...hypothesis.evidence);
      }
      for (const reason of step.failure.primary.reasons) failedAssumptions.add(reason);
    }
    if (stepFailed) {
      const family = step.action.strategyId ? 'strategy:' + step.action.strategyId : step.action.family;
      const fingerprint = strategyFingerprint({
        family,
        requiresFacts: [],
        expectedEffects: step.action.expectedEffects ?? []
      });
      const current = strategyFailures.get(fingerprint);
      strategyFailures.set(fingerprint, {
        family: step.action.family,
        count: (current?.count ?? 0) + 1
      });
    }
  }

  for (const belief of input.beliefs) {
    if (belief.status === 'CONFLICTED' || belief.status === 'DISPROVEN' || belief.status === 'STALE') {
      failedAssumptions.add('fact:' + belief.factKey + ':' + belief.status.toLowerCase());
    }
    evidence.push(...belief.supportingEvidence, ...belief.contradictingEvidence);
  }

  const activeHypotheses = [...hypothesisScores.values()]
    .sort((a, b) => b.score - a.score || a.hypothesis.class.localeCompare(b.hypothesis.class))
    .slice(0, maxHypotheses)
    .map((item) => item.hypothesis);

  const repeatedFailureFamilies = [...new Set(
    [...strategyFailures.values()]
      .filter((item) => item.count >= 2)
      .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family))
      .map((item) => item.family)
  )];

  const progressLevel = input.steps.length > 0
    ? input.steps[input.steps.length - 1]!.progress.level
    : 'NONE';
  const criticalEvidence = uniqueEvidence(evidence).slice(0, maxEvidence);

  return {
    goalId,
    verifiedFacts: unique(verifiedFacts),
    unresolvedFacts: unique(unresolvedFacts),
    failedAssumptions: [...failedAssumptions].slice(-50),
    activeHypotheses,
    recentStrategies: recentStrategies.slice(-maxRecent),
    repeatedFailureFamilies,
    progressLevel,
    criticalEvidence,
    omittedSteps: Math.max(0, input.steps.length - maxRecent)
  };
}

function uniqueEvidence(items: EvidenceRef[]): EvidenceRef[] {
  return [...new Map(items.map((item) => [item.digest, item])).values()]
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
}
function unique(values: string[]): string[] { return [...new Set(values)].sort(); }
function bounded(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string') throw new Error(label + ' must be a string.');
  const value = input;
  if (!value || value.length > max) throw new Error(label + ' is invalid.');
  return value;
}
function integer(input: unknown, min: number, max: number, label: string): number {
  if (typeof input !== 'number') throw new Error(label + ' must be a number.');
  const value = input;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(label + ' is invalid.');
  return value;
}
