import type { AnalyzeOutcomeResult } from '../../packages/adaptive-intelligence/src/adaptive-intelligence-kernel.ts';
import { VerifiedPlanRuntime } from '../../packages/verified-plan-runtime/src/runtime.ts';
import type {
  BeliefView,
  CompiledGoal,
  ExecutionObservation,
  PlanGraph,
  PlanNodeState
} from '../../packages/verified-plan-runtime/src/contracts.ts';
import { adaptiveRecoveryToAdvisory, type RuntimeAdvisoryCommand } from './intelligence-adapters.ts';

export interface AdaptiveShadowAdvisory {
  command: RuntimeAdvisoryCommand;
  reasonCode: string;
  confidence?: number;
}

export function adaptiveResultToShadowAdvisory(result: AnalyzeOutcomeResult): AdaptiveShadowAdvisory | undefined {
  if (result.recovery) {
    return {
      command: adaptiveRecoveryToAdvisory(result.recovery.selected.kind),
      reasonCode: result.failure?.primary.class ?? 'RECOVERY_RECOMMENDED',
      ...(result.failure ? { confidence: result.failure.primary.probability } : {})
    };
  }
  if (result.progress.verificationRequired) {
    return { command: 'VERIFY', reasonCode: 'PROGRESS_REQUIRES_VERIFICATION', confidence: result.progress.confidence };
  }
  if (result.progress.level === 'NONE') {
    return { command: 'OBSERVE', reasonCode: 'NO_VERIFIED_PROGRESS', confidence: result.progress.confidence };
  }
  return undefined;
}

/**
 * Shadow wrapper around VerifiedPlanRuntime.
 * It has no provider, authority, lease, or dispatch dependency.
 * It can only ingest beliefs/outcomes that the authoritative runtime supplies.
 */
export class VerifiedPlanShadow {
  #runtime: VerifiedPlanRuntime;

  constructor(goal: CompiledGoal, graph: PlanGraph) {
    this.#runtime = new VerifiedPlanRuntime(goal, graph);
  }

  bindAuthoritativeBeliefs(beliefs: BeliefView[]) {
    return this.#runtime.bindBeliefs(beliefs);
  }

  readyNodes(): PlanNodeState[] {
    return this.#runtime.states().filter((state) => state.status === 'READY');
  }

  recordAuthoritativeOutcome(nodeId: string, observation: ExecutionObservation, now?: string) {
    const state = this.#runtime.states().find((item) => item.nodeId === nodeId);
    if (!state) throw new Error('unknown shadow plan node.');
    if (state.status !== 'READY') throw new Error('shadow plan node is not READY.');
    this.#runtime.startNode(nodeId, now);
    return this.#runtime.recordExecution(nodeId, observation, now);
  }

  stateDigest(): string {
    return this.#runtime.stateDigest();
  }

  exportEnvelope() {
    return this.#runtime.exportEnvelope();
  }
}
