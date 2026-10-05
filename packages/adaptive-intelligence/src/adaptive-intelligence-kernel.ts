import type {
  ActionDescriptor,
  ActionOutcome,
  BeliefObservation,
  FailureAttribution,
  GoalDescriptor,
  ProgressAssessment,
  RecoveryDecision,
  RecoveryOption,
  SkillDraft,
  StateSnapshot,
  StrategyCandidate,
  StrategyEvaluation,
  TrajectoryStep
} from './contracts.ts';
import { EpistemicStateEngine } from './epistemic-state.ts';
import { CausalGraph } from './causal-graph.ts';
import { attributeFailure, type FailureAttributionInput } from './failure-attribution.ts';
import { assessProgress } from './progress-engine.ts';
import { selectStrategy, type StrategySelection } from './strategy-engine.ts';
import { selectRecovery } from './counterfactual-recovery.ts';
import { compressTrajectory } from './trajectory-compressor.ts';
import { LearningFirewall, type LearningPromotionInput } from './learning-firewall.ts';
import { CalibrationTracker } from './calibration.ts';

export interface AnalyzeOutcomeInput {
  goal: GoalDescriptor;
  before: StateSnapshot;
  action: ActionDescriptor;
  outcome: ActionOutcome;
  after: StateSnapshot;
  relevantFactKeys: string[];
  progressSignals?: string[];
  independentVerification?: boolean;
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

  constructor(options: {
    clock?: () => Date;
    maxTrajectorySteps?: number;
    maxClaimsPerFact?: number;
    maxTransitions?: number;
    maxCalibrationSamples?: number;
  } = {}) {
    this.epistemic = new EpistemicStateEngine({
      clock: options.clock,
      maxClaimsPerFact: options.maxClaimsPerFact
    });
    this.causal = new CausalGraph({
      clock: options.clock,
      maxTransitions: options.maxTransitions
    });
    this.calibration = new CalibrationTracker({ maxSamples: options.maxCalibrationSamples });
    this.learning = new LearningFirewall();
    this.#maxTrajectorySteps = integer(options.maxTrajectorySteps ?? 10_000, 1, 100_000, 'maxTrajectorySteps');
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
      independentVerification: input.independentVerification
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
      index: this.#trajectory.length,
      action: structuredClone(input.action),
      outcome: structuredClone(input.outcome),
      delta: structuredClone(transition.delta),
      progress: structuredClone(progress),
      ...(failure ? { failure: structuredClone(failure) } : {})
    };
    this.#trajectory.push(step);
    if (this.#trajectory.length > this.#maxTrajectorySteps) {
      this.#trajectory.splice(0, this.#trajectory.length - this.#maxTrajectorySteps);
    }

    if (strategy) {
      this.calibration.record({
        prediction: strategy.selected.expectedSuccess,
        outcome: progress.level === 'GOAL_ACHIEVED' || progress.level === 'SUBGOAL_PROGRESS' ? 1 : 0,
        bucket: 'strategy'
      });
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
    return compressTrajectory({
      goal,
      steps: this.#trajectory,
      beliefs: this.epistemic.snapshot(relevantFactKeys)
    });
  }

  promoteSkill(input: LearningPromotionInput) {
    return this.learning.evaluate(input);
  }

  trajectory(): TrajectoryStep[] {
    return structuredClone(this.#trajectory);
  }
}

function integer(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(label + ' is invalid.');
  return value;
}
