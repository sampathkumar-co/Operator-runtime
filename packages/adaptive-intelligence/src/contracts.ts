export type EpistemicStatus =
  | 'KNOWN'
  | 'SUPPORTED'
  | 'CONFLICTED'
  | 'STALE'
  | 'UNKNOWN'
  | 'UNOBSERVABLE'
  | 'DISPROVEN';

export interface EvidenceRef {
  digest: string;
  source: string;
  observedAt: string;
  channel?: string;
  scope?: string;
  /**
   * Explicit correlation/independence bucket for confidence aggregation.
   * Evidence sharing the same key must not multiply confidence.
   */
  independenceKey?: string;
}

export interface BeliefObservation {
  factKey: string;
  valueDigest: string;
  polarity: 'supports' | 'contradicts';
  confidence: number;
  evidence: EvidenceRef;
  expiresAt?: string;
  summary?: string;
}

export interface BeliefResolution {
  factKey: string;
  status: EpistemicStatus;
  confidence: number;
  selectedValueDigest?: string;
  supportingEvidence: EvidenceRef[];
  contradictingEvidence: EvidenceRef[];
  staleEvidence: EvidenceRef[];
  alternatives: Array<{ valueDigest: string; confidence: number }>;
  updatedAt: string;
}

export interface GoalDescriptor {
  id: string;
  kind: string;
  objective: string;
  successFactKeys: string[];
  forbiddenFactKeys?: string[];
}

export interface StateFact {
  key: string;
  valueDigest: string;
  confidence: number;
  evidence: EvidenceRef[];
}

export interface StateSnapshot {
  id: string;
  observedAt: string;
  scopeKey: string;
  stateVersion?: string;
  facts: StateFact[];
}

export interface ActionDescriptor {
  id: string;
  family: string;
  capability: string;
  risk: 'read' | 'write' | 'execute' | 'network' | 'unknown';
  semanticTarget?: string;
  strategyId?: string;
  expectedEffects?: string[];
}

export interface ActionOutcome {
  ok: boolean;
  provider?: string;
  durationMs?: number;
  errorCode?: string;
  sideEffectState?: 'none' | 'known' | 'uncertain';
  executionPhase?: 'pre_dispatch' | 'dispatching' | 'effect_observed' | 'unknown';
  evidence: EvidenceRef[];
}

export interface StateDelta {
  changedFactKeys: string[];
  addedFactKeys: string[];
  removedFactKeys: string[];
  expectedEffectsSatisfied: string[];
  expectedEffectsMissing: string[];
  unrelatedEffects: string[];
  progressSignals: string[];
}

export interface CausalTransition {
  id: string;
  before: StateSnapshot;
  action: ActionDescriptor;
  outcome: ActionOutcome;
  after: StateSnapshot;
  delta: StateDelta;
  causalConfidence: number;
  recordedAt: string;
}

export type FailureClass =
  | 'PERCEPTION_INCOMPLETE'
  | 'TARGET_AMBIGUOUS'
  | 'TARGET_STALE'
  | 'GEOMETRY_INVALID'
  | 'ACTION_CONTRACT_REJECTED'
  | 'ACTION_NO_EFFECT'
  | 'SIDE_EFFECT_UNCERTAIN'
  | 'GOAL_PROGRESS_FALSE_POSITIVE'
  | 'PLANNER_STRATEGY_WRONG'
  | 'MODEL_REASONING_WRONG'
  | 'PROVIDER_TRANSIENT'
  | 'RESOURCE_CONTENTION'
  | 'STATE_CHANGED_EXTERNALLY'
  | 'VERIFICATION_INSUFFICIENT'
  | 'AUTHORITY_DENIED'
  | 'BUDGET_EXHAUSTED'
  | 'UNKNOWN';

export interface FailureHypothesis {
  class: FailureClass;
  probability: number;
  reasons: string[];
  evidence: EvidenceRef[];
  discriminatingObservation?: string;
}

export interface FailureAttribution {
  primary: FailureHypothesis;
  alternatives: FailureHypothesis[];
  entropy: number;
  evidenceCoverage: number;
}

export interface StrategyCandidate {
  id: string;
  family: string;
  description: string;
  expectedSuccess: number;
  expectedCost: number;
  uncertainty: number;
  verificationStrength: number;
  repeatedEquivalentFailures?: number;
  requiresFacts?: string[];
  expectedEffects?: string[];
}

export interface StrategyEvaluation extends StrategyCandidate {
  utility: number;
  penalties: string[];
}

export type RecoveryKind =
  | 'REOBSERVE'
  | 'REGROUND'
  | 'REPLAN'
  | 'REPAIR'
  | 'RECONCILE'
  | 'WAIT'
  | 'VERIFY'
  | 'FAIL_SAFE';

export interface RecoveryOption {
  id: string;
  kind: RecoveryKind;
  description: string;
  expectedInformationGain: number;
  expectedSuccess: number;
  expectedCost: number;
  risk: number;
  resolvesHypotheses: FailureClass[];
}

export interface RecoveryDecision {
  selected: RecoveryOption;
  alternatives: RecoveryOption[];
  reason: string;
}

export type ProgressLevel =
  | 'NONE'
  | 'ACTION_EXECUTED'
  | 'STATE_CHANGED'
  | 'SUBGOAL_PROGRESS'
  | 'GOAL_ACHIEVED';

export interface ProgressAssessment {
  level: ProgressLevel;
  confidence: number;
  creditedSignals: string[];
  rejectedSignals: string[];
  goalFactsSatisfied: string[];
  goalFactsMissing: string[];
  forbiddenFactsObserved: string[];
  verificationRequired: boolean;
}

export interface TrajectoryStep {
  index: number;
  action: ActionDescriptor;
  outcome: ActionOutcome;
  delta: StateDelta;
  progress: ProgressAssessment;
  failure?: FailureAttribution;
}

export interface CompressedTrajectory {
  goalId: string;
  verifiedFacts: string[];
  unresolvedFacts: string[];
  failedAssumptions: string[];
  activeHypotheses: FailureHypothesis[];
  recentStrategies: string[];
  repeatedFailureFamilies: string[];
  progressLevel: ProgressLevel;
  criticalEvidence: EvidenceRef[];
  omittedSteps: number;
}

export interface SkillStep {
  actionFamily: string;
  capability: string;
  preconditions: string[];
  expectedEffects: string[];
  verificationFacts: string[];
  recoveryFamilies?: string[];
}

export interface SkillDraft {
  id: string;
  objectiveKind: string;
  title: string;
  scopeClass: string;
  assumptions: string[];
  steps: SkillStep[];
  verificationDigests: string[];
  sourceRunIds: string[];
  benchmarkIdentifiers?: string[];
}

export type LearningMode = 'NORMAL' | 'SHADOW' | 'EVALUATION_FROZEN';

export interface LearningReceipt {
  skillId: string;
  promoted: boolean;
  reason: string;
  verificationDigests: string[];
  policyVersion: string;
  sourceRunIds: string[];
}

export interface CalibrationSample {
  prediction: number;
  outcome: 0 | 1;
  bucket?: string;
}
