import type {
  BeliefResolution,
  CausalTransition,
  EvidenceRef,
  FailureAttribution,
  FailureClass,
  FailureHypothesis
} from './contracts.ts';

export interface FailureAttributionInput {
  transition: CausalTransition;
  beliefs?: BeliefResolution[];
  targetConfidence?: number;
  geometryValid?: boolean;
  verificationSufficient?: boolean;
  authorityDenied?: boolean;
  budgetExhausted?: boolean;
  resourceBusy?: boolean;
  providerTransient?: boolean;
  externalStateChange?: boolean;
  plannerExpectedProgress?: boolean;
  modelReasoningConflict?: boolean;
}

interface ScoredHypothesis {
  class: FailureClass;
  score: number;
  reasons: string[];
  evidence: EvidenceRef[];
  discriminatingObservation?: string;
}

export function attributeFailure(input: FailureAttributionInput): FailureAttribution {
  const t = input.transition;
  const hypotheses = new Map<FailureClass, ScoredHypothesis>();
  const add = (
    cls: FailureClass,
    score: number,
    reason: string,
    evidence: EvidenceRef[] = [],
    discriminatingObservation?: string
  ) => {
    const existing = hypotheses.get(cls) ?? { class: cls, score: 0, reasons: [], evidence: [] };
    existing.score += Math.max(0, score);
    if (reason && !existing.reasons.includes(reason)) existing.reasons.push(reason);
    existing.evidence.push(...evidence);
    if (discriminatingObservation && !existing.discriminatingObservation) existing.discriminatingObservation = discriminatingObservation;
    hypotheses.set(cls, existing);
  };

  const errorCode = (t.outcome.errorCode ?? '').toUpperCase();
  const evidence = uniqueEvidence(t.outcome.evidence);
  const beliefs = input.beliefs ?? [];

  if (input.authorityDenied || /APPROVAL|AUTHORITY|POLICY|PERMISSION/.test(errorCode)) {
    add('AUTHORITY_DENIED', 4, 'Execution was rejected at an authority or approval boundary.', evidence);
  }
  if (input.budgetExhausted || /BUDGET|STEP_LIMIT|TOKEN_LIMIT|TIMEOUT_BUDGET/.test(errorCode)) {
    add('BUDGET_EXHAUSTED', 4, 'A bounded execution budget was exhausted.', evidence);
  }
  if (t.outcome.sideEffectState === 'uncertain' || /RECONCIL|UNCERTAIN/.test(errorCode)) {
    add('SIDE_EFFECT_UNCERTAIN', 4.5, 'Mutation outcome is not safely known and must not be blindly replayed.', evidence, 'Reconcile provider/world post-state before choosing any mutation retry.');
  }
  if (input.resourceBusy || /RESOURCE.*BUSY|LOCK_BUSY|LEASE/.test(errorCode)) {
    add('RESOURCE_CONTENTION', 3.5, 'Execution was blocked by resource contention or lease state.', evidence, 'Observe resource ownership/lease expiry.');
  }
  if (input.providerTransient || /TEMPORARY|UNAVAILABLE|OFFLINE|CONNECTION|RATE_LIMIT|ECONN/.test(errorCode)) {
    add('PROVIDER_TRANSIENT', 3.2, 'Provider or transport failure appears transient.', evidence, 'Probe provider health without repeating the mutation.');
  }
  if (/AMBIGUOUS|NOT_UNIQUE/.test(errorCode)) {
    add('TARGET_AMBIGUOUS', 4, 'Multiple targets satisfy the current grounding hypothesis.', evidence, 'Reobserve target-local semantics and disambiguating ancestry/geometry.');
  }
  if (/STALE|TARGET_NOT_FOUND|ELEMENT_NOT_FOUND|STATE_CHANGED|FINGERPRINT|PRECONDITION/.test(errorCode)) {
    add('TARGET_STALE', 3.7, 'Target or precondition identity changed after the prior observation.', evidence, 'Reobserve and compare target identity/state version.');
  }
  if (/GEOMETRY|HIT_TEST|BOUNDS|OCCLUDED|OFFSCREEN/.test(errorCode) || input.geometryValid === false) {
    add('GEOMETRY_INVALID', 3.5, 'Physical geometry or hit-testing assumptions are invalid.', evidence, 'Reacquire target bounds and occlusion/hit-test evidence.');
  }
  if (/CONTRACT|INPUT_INVALID|UNSUPPORTED/.test(errorCode)) {
    add('ACTION_CONTRACT_REJECTED', 3.2, 'The action contract was rejected before useful execution.', evidence);
  }
  if (t.outcome.ok && totalStateChanges(t) === 0) {
    add('ACTION_NO_EFFECT', 4, 'Provider reported success but no durable state delta was observed.', evidence, 'Reobserve the expected effect facts after settling.');
  }
  if (!t.outcome.ok && t.outcome.executionPhase === 'pre_dispatch' && t.outcome.sideEffectState === 'none') {
    add('ACTION_CONTRACT_REJECTED', 2, 'Failure occurred before dispatch with no side effect.', evidence);
  }
  if (t.delta.expectedEffectsMissing.length > 0) {
    add('ACTION_NO_EFFECT', 2.6, 'Expected effect facts are missing from the post-state.', evidence, 'Inspect the specific missing expected effect facts.');
  }
  if (t.delta.unrelatedEffects.length > Math.max(2, t.delta.expectedEffectsSatisfied.length * 2)) {
    add('STATE_CHANGED_EXTERNALLY', 2.4, 'Observed state changed mostly outside the action expected-effect set.', evidence, 'Reobserve environment mutation/version signals to separate external change from action effect.');
  }
  if (input.externalStateChange) {
    add('STATE_CHANGED_EXTERNALLY', 3.8, 'Independent evidence says state changed externally.', evidence);
  }
  if (input.verificationSufficient === false) {
    add('VERIFICATION_INSUFFICIENT', 3.8, 'Available evidence cannot independently prove the claimed outcome.', evidence, 'Acquire read-only outcome evidence linked to the goal contract.');
  }
  if (input.plannerExpectedProgress && t.delta.progressSignals.length === 0 && t.delta.expectedEffectsSatisfied.length === 0) {
    add('GOAL_PROGRESS_FALSE_POSITIVE', 3.5, 'Planner expected progress but machine evidence contains no goal-linked progress.', evidence);
  }
  if (input.modelReasoningConflict) {
    add('MODEL_REASONING_WRONG', 3, 'Planner/model reasoning conflicts with durable machine evidence.', evidence);
  }

  const targetConfidence = input.targetConfidence;
  if (targetConfidence !== undefined) {
    const confidence = unit(targetConfidence, 'targetConfidence');
    if (confidence < 0.45) {
      add('PERCEPTION_INCOMPLETE', 2.8 + (0.45 - confidence) * 2, 'Target confidence is below the safe reasoning threshold.', [], 'Acquire a stronger semantic/visual observation of the target region.');
    }
  }

  for (const belief of beliefs) {
    if (belief.status === 'CONFLICTED') {
      add('PERCEPTION_INCOMPLETE', 2.2, 'Relevant world/perception facts conflict across evidence sources.', [...belief.supportingEvidence, ...belief.contradictingEvidence], 'Resolve conflicting fact ' + belief.factKey + '.');
    } else if (belief.status === 'STALE') {
      add('TARGET_STALE', 1.8, 'Relevant fact is stale: ' + belief.factKey + '.', belief.staleEvidence, 'Reobserve stale fact ' + belief.factKey + '.');
    } else if (belief.status === 'UNKNOWN' || belief.status === 'UNOBSERVABLE') {
      add('PERCEPTION_INCOMPLETE', 1.6, 'Relevant fact is not currently known: ' + belief.factKey + '.', [], 'Seek evidence for fact ' + belief.factKey + '.');
    }
  }

  if (!t.outcome.ok && hypotheses.size === 0) {
    add('UNKNOWN', 1, 'Failure has no currently supported causal attribution.', evidence, 'Acquire a minimally invasive observation that separates execution, target, and provider causes.');
  }
  if (t.outcome.ok && hypotheses.size === 0 && t.delta.progressSignals.length === 0) {
    add('PLANNER_STRATEGY_WRONG', 1.5, 'Action completed but produced no explicit goal-progress signal.', evidence);
  }

  const normalized = normalize([...hypotheses.values()]);
  const primary = normalized[0] ?? {
    class: 'UNKNOWN' as const,
    probability: 1,
    reasons: ['No attribution evidence was available.'],
    evidence: []
  };
  const entropy = normalized.length <= 1 ? 0 : normalized.reduce((sum, item) => {
    return item.probability > 0 ? sum - item.probability * Math.log(item.probability) : sum;
  }, 0) / Math.log(normalized.length);
  const evidenceSignals = countEvidenceSignals(input);
  const evidenceCoverage = clamp01(evidenceSignals / 8);

  return {
    primary,
    alternatives: normalized.slice(1),
    entropy: round(entropy),
    evidenceCoverage: round(evidenceCoverage)
  };
}

function normalize(items: ScoredHypothesis[]): FailureHypothesis[] {
  const sorted = items
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.class.localeCompare(b.class));
  const total = sorted.reduce((sum, item) => sum + item.score, 0) || 1;
  return sorted.map((item) => ({
    class: item.class,
    probability: round(item.score / total),
    reasons: [...item.reasons],
    evidence: uniqueEvidence(item.evidence),
    ...(item.discriminatingObservation ? { discriminatingObservation: item.discriminatingObservation } : {})
  }));
}

function countEvidenceSignals(input: FailureAttributionInput): number {
  let count = 0;
  if (input.transition.outcome.evidence.length) count += 1;
  if (input.transition.delta.changedFactKeys.length || input.transition.delta.addedFactKeys.length || input.transition.delta.removedFactKeys.length) count += 1;
  if (input.transition.delta.expectedEffectsSatisfied.length || input.transition.delta.expectedEffectsMissing.length) count += 1;
  if (input.beliefs?.length) count += 1;
  if (input.targetConfidence !== undefined) count += 1;
  if (input.geometryValid !== undefined) count += 1;
  if (input.verificationSufficient !== undefined) count += 1;
  if (input.transition.before.stateVersion || input.transition.after.stateVersion) count += 1;
  return count;
}

function totalStateChanges(t: CausalTransition): number {
  return t.delta.changedFactKeys.length + t.delta.addedFactKeys.length + t.delta.removedFactKeys.length;
}
function uniqueEvidence(items: EvidenceRef[]): EvidenceRef[] {
  return [...new Map(items.map((item) => [item.digest, item])).values()]
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
}
function unit(input: unknown, label: string): number {
  if (typeof input !== 'number') throw new Error(label + ' must be a number.');
  const value = input;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(label + ' must be between 0 and 1.');
  return value;
}
function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
