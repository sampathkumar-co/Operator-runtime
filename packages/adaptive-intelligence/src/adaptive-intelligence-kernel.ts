import crypto from 'node:crypto';
import type {
  ActionDescriptor,
  ActionOutcome,
  BeliefObservation,
  CalibrationSample,
  CausalTransition,
  FailureAttribution,
  GoalDescriptor,
  ProgressAssessment,
  RecoveryDecision,
  RecoveryOption,
  SkillDraft,
  StateSnapshot,
  StrategyCandidate,
  StrategyEvaluation,
  TrajectoryStep,
  VerificationReceiptRef
} from './contracts.ts';
import { EpistemicStateEngine, type EpistemicStateSnapshot } from './epistemic-state.ts';
import { CausalGraph } from './causal-graph.ts';
import { attributeFailure, type FailureAttributionInput } from './failure-attribution.ts';
import { assessProgress } from './progress-engine.ts';
import { selectStrategy, type StrategySelection } from './strategy-engine.ts';
import { selectRecovery } from './counterfactual-recovery.ts';
import { compressTrajectory } from './trajectory-compressor.ts';
import { LearningFirewall, type LearningPromotionInput } from './learning-firewall.ts';
import { CalibrationTracker } from './calibration.ts';
import {
  decodeVersionedState,
  encodeVersionedState,
  canonicalJson,
  type VersionedStateEnvelope
} from './versioned-state.ts';

export interface AdaptiveIntelligenceKernelState {
  version: 1;
  epistemic: EpistemicStateSnapshot;
  causal: CausalTransition[];
  calibration: CalibrationSample[];
  learningReplayDigests: string[];
  trajectory: TrajectoryStep[];
  nextTrajectoryIndex: number;
}

export interface AdaptiveIntelligenceKernelOptions {
  clock?: () => Date;
  maxTrajectorySteps?: number;
  maxClaimsPerFact?: number;
  maxTransitions?: number;
  maxCalibrationSamples?: number;
  state?: AdaptiveIntelligenceKernelState;
}

export type AdaptiveIntelligenceKernelEnvelope = VersionedStateEnvelope<AdaptiveIntelligenceKernelState>;

export interface AnalyzeOutcomeInput {
  goal: GoalDescriptor;
  before: StateSnapshot;
  action: ActionDescriptor;
  outcome: ActionOutcome;
  after: StateSnapshot;
  relevantFactKeys: string[];
  progressSignals?: string[];
  verificationReceipt?: VerificationReceiptRef;
  attributionSignals?: Omit<FailureAttributionInput, 'transition' | 'beliefs'>;
  strategies?: StrategyCandidate[];
  recoveryOptions?: RecoveryOption[];
  remainingCostBudget?: number;
}

export interface AnalyzeOutcomeResult {
  transition: ReturnType<CausalGraph['record']>;
  beliefs: ReturnType<EpistemicStateEngine['snapshot']>;
  failure?: FailureAttribution;
  progress: ProgressAssessment;
  strategy?: StrategySelection;
  recovery?: RecoveryDecision;
}

export class AdaptiveIntelligenceKernel {
  readonly epistemic: EpistemicStateEngine;
  readonly causal: CausalGraph;
  readonly calibration: CalibrationTracker;
  readonly learning: LearningFirewall;

  #trajectory: TrajectoryStep[] = [];
  #maxTrajectorySteps: number;
  #nextTrajectoryIndex = 0;

  constructor(options: AdaptiveIntelligenceKernelOptions = {}) {
    this.#maxTrajectorySteps = integer(options.maxTrajectorySteps ?? 10_000, 1, 100_000, 'maxTrajectorySteps');
    const state = options.state
      ? normalizeKernelState(options.state, this.#maxTrajectorySteps)
      : undefined;

    this.epistemic = state
      ? EpistemicStateEngine.fromState(state.epistemic, {
          clock: options.clock,
          maxClaimsPerFact: options.maxClaimsPerFact
        })
      : new EpistemicStateEngine({
          clock: options.clock,
          maxClaimsPerFact: options.maxClaimsPerFact
        });

    this.causal = state
      ? CausalGraph.fromState(state.causal, {
          clock: options.clock,
          maxTransitions: options.maxTransitions
        })
      : new CausalGraph({
          clock: options.clock,
          maxTransitions: options.maxTransitions
        });

    this.calibration = state
      ? CalibrationTracker.fromSnapshot(state.calibration, {
          maxSamples: options.maxCalibrationSamples
        })
      : new CalibrationTracker({ maxSamples: options.maxCalibrationSamples });

    this.learning = state
      ? LearningFirewall.fromState(state.learningReplayDigests, { clock: options.clock })
      : new LearningFirewall({ clock: options.clock });

    if (state) {
      this.#trajectory = validateTrajectoryAgainstCausal(
        state.trajectory,
        this.causal.exportState(),
        this.#maxTrajectorySteps,
        state.nextTrajectoryIndex
      );
      this.#nextTrajectoryIndex = state.nextTrajectoryIndex;
    }
  }

  static fromState(
    state: AdaptiveIntelligenceKernelState,
    options: Omit<AdaptiveIntelligenceKernelOptions, 'state'> = {}
  ): AdaptiveIntelligenceKernel {
    return new AdaptiveIntelligenceKernel({ ...options, state });
  }

  static fromEnvelope(
    envelope: unknown,
    options: Omit<AdaptiveIntelligenceKernelOptions, 'state'> = {}
  ): AdaptiveIntelligenceKernel {
    const decoded = decodeVersionedState(envelope, {
      kind: 'adaptive-kernel',
      validate: (payload) => normalizeKernelState(payload, options.maxTrajectorySteps ?? 10_000)
    });
    return AdaptiveIntelligenceKernel.fromState(decoded.payload, options);
  }

  exportState(): AdaptiveIntelligenceKernelState {
    return {
      version: 1,
      epistemic: this.epistemic.exportState(),
      causal: this.causal.exportState(),
      calibration: this.calibration.snapshot(),
      learningReplayDigests: this.learning.exportState(),
      trajectory: structuredClone(this.#trajectory),
      nextTrajectoryIndex: this.#nextTrajectoryIndex
    };
  }

  exportEnvelope(options: { clock?: () => Date } = {}): AdaptiveIntelligenceKernelEnvelope {
    return encodeVersionedState('adaptive-kernel', this.exportState(), options);
  }

  stateDigest(): string {
    return crypto.createHash('sha256').update(canonicalJson(this.exportState())).digest('hex');
  }

  observeBelief(observation: BeliefObservation) {
    return this.epistemic.observe(observation);
  }

  analyzeOutcome(input: AnalyzeOutcomeInput): AnalyzeOutcomeResult {
    const transition = this.causal.record({
      before: input.before,
      action: input.action,
      outcome: input.outcome,
      after: input.after,
      progressSignals: input.progressSignals
    });
    const beliefs = this.epistemic.snapshot(input.relevantFactKeys);
    const shouldAttribute = !input.outcome.ok
      || input.outcome.sideEffectState === 'uncertain'
      || transition.delta.expectedEffectsMissing.length > 0
      || (input.attributionSignals?.plannerExpectedProgress === true && transition.delta.progressSignals.length === 0);

    const failure = shouldAttribute
      ? attributeFailure({
          transition,
          beliefs,
          ...(input.attributionSignals ?? {})
        })
      : undefined;

    const progress = assessProgress({
      goal: input.goal,
      transition,
      beliefs,
      verificationReceipt: input.verificationReceipt
    });

    const recentTransitions = this.causal.recent(30).reverse();
    const strategy = input.strategies?.length
      ? selectStrategy({
          candidates: input.strategies,
          recentTransitions,
          ...(failure ? { failure } : {}),
          remainingCostBudget: input.remainingCostBudget
        })
      : undefined;

    const recovery = failure && input.recoveryOptions?.length
      ? selectRecovery({
          attribution: failure,
          options: input.recoveryOptions,
          remainingCostBudget: input.remainingCostBudget
        })
      : undefined;

    const step: TrajectoryStep = {
      index: this.#nextTrajectoryIndex,
      action: structuredClone(transition.action),
      outcome: structuredClone(transition.outcome),
      delta: structuredClone(transition.delta),
      progress: structuredClone(progress),
      ...(failure ? { failure: structuredClone(failure) } : {})
    };
    this.#nextTrajectoryIndex += 1;
    this.#trajectory.push(step);
    if (this.#trajectory.length > this.#maxTrajectorySteps) {
      this.#trajectory.splice(0, this.#trajectory.length - this.#maxTrajectorySteps);
    }

    return {
      transition,
      beliefs,
      ...(failure ? { failure } : {}),
      progress,
      ...(strategy ? { strategy } : {}),
      ...(recovery ? { recovery } : {})
    };
  }

  compressedTrajectory(goal: GoalDescriptor, relevantFactKeys: string[]) {
    const compressed = compressTrajectory({
      goal,
      steps: this.#trajectory,
      beliefs: this.epistemic.snapshot(relevantFactKeys)
    });
    const evictedBeforeRetainedWindow = this.#trajectory.length > 0
      ? this.#trajectory[0]!.index
      : this.#nextTrajectoryIndex;
    return {
      ...compressed,
      omittedSteps: compressed.omittedSteps + evictedBeforeRetainedWindow
    };
  }

  promoteSkill(input: LearningPromotionInput) {
    return this.learning.evaluate(input);
  }

  trajectory(): TrajectoryStep[] {
    return structuredClone(this.#trajectory);
  }
}

function normalizeKernelState(
  input: unknown,
  maxTrajectoryStepsInput: number
): AdaptiveIntelligenceKernelState {
  if (!input || typeof input !== 'object') throw new Error('adaptive intelligence kernel state is required.');
  const raw = input as AdaptiveIntelligenceKernelState;
  if (raw.version !== 1) throw new Error('Unsupported adaptive intelligence kernel state version.');
  const maxTrajectorySteps = integer(maxTrajectoryStepsInput, 1, 100_000, 'maxTrajectorySteps');
  if (!raw.epistemic || typeof raw.epistemic !== 'object') throw new Error('kernel epistemic state is invalid.');
  if (!Array.isArray(raw.causal) || raw.causal.length > 100_000) throw new Error('kernel causal state is invalid.');
  if (!Array.isArray(raw.calibration) || raw.calibration.length > 1_000_000) throw new Error('kernel calibration state is invalid.');
  if (!Array.isArray(raw.learningReplayDigests) || raw.learningReplayDigests.length > 1_000_000) {
    throw new Error('kernel learning replay state is invalid.');
  }
  if (!Array.isArray(raw.trajectory) || raw.trajectory.length > maxTrajectorySteps) {
    throw new Error('kernel trajectory state exceeds configured capacity.');
  }
  const nextTrajectoryIndex = integer(raw.nextTrajectoryIndex, 0, Number.MAX_SAFE_INTEGER, 'nextTrajectoryIndex');
  return {
    version: 1,
    epistemic: structuredClone(raw.epistemic),
    causal: structuredClone(raw.causal),
    calibration: structuredClone(raw.calibration),
    learningReplayDigests: [...raw.learningReplayDigests],
    trajectory: structuredClone(raw.trajectory),
    nextTrajectoryIndex
  };
}

function validateTrajectoryAgainstCausal(
  stepsInput: TrajectoryStep[],
  causalTransitions: CausalTransition[],
  maxTrajectorySteps: number,
  nextTrajectoryIndex: number
): TrajectoryStep[] {
  if (!Array.isArray(stepsInput) || stepsInput.length > maxTrajectorySteps) {
    throw new Error('kernel trajectory state exceeds configured capacity.');
  }
  const steps = structuredClone(stepsInput);
  let priorIndex: number | undefined;
  for (const step of steps) {
    if (!step || typeof step !== 'object') throw new Error('kernel trajectory step is invalid.');
    const index = integer(step.index, 0, Number.MAX_SAFE_INTEGER, 'trajectory.index');
    if (priorIndex !== undefined && index !== priorIndex + 1) {
      throw new Error('kernel trajectory indices must be strictly contiguous.');
    }
    priorIndex = index;
  }
  if (steps.length === 0) {
    if (nextTrajectoryIndex !== 0) throw new Error('empty kernel trajectory must have next index zero.');
    if (causalTransitions.length !== 0) throw new Error('kernel causal history cannot exist without trajectory history.');
    return steps;
  }
  if (nextTrajectoryIndex !== steps[steps.length - 1]!.index + 1) {
    throw new Error('kernel next trajectory index does not follow retained history.');
  }
  if (causalTransitions.length === 0) throw new Error('kernel trajectory cannot exist without causal history.');

  const compareCount = Math.min(steps.length, causalTransitions.length);
  const stepSuffix = steps.slice(-compareCount);
  const causalSuffix = causalTransitions.slice(-compareCount);
  for (let index = 0; index < compareCount; index += 1) {
    const step = stepSuffix[index]!;
    const transition = causalSuffix[index]!;
    const stepExecution = JSON.stringify({
      action: step.action,
      outcome: step.outcome,
      delta: step.delta
    });
    const causalExecution = JSON.stringify({
      action: transition.action,
      outcome: transition.outcome,
      delta: transition.delta
    });
    if (stepExecution !== causalExecution) {
      throw new Error('kernel trajectory execution truth does not match causal history.');
    }
  }
  return steps;
}

function integer(input: unknown, min: number, max: number, label: string): number {
  if (typeof input !== 'number') throw new Error(label + ' must be a number.');
  const value = input;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(label + ' is invalid.');
  return value;
}
