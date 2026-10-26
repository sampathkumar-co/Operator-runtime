import { OperatorError } from '../../../src/core/errors.ts';
import {
  ProjectQualityGatePlanner, SemanticTaskPlanner, SemanticWorkflowPlanner,
  type TaskPlanner
} from '../../../src/core/task-orchestrator.ts';
import { LocalModelAutonomousWorkflowPlanner } from '../../../src/core/local-model-subgoal-planner.ts';

type LocalModelOptIn = {
  /** Explicit owner-controlled opt-in. No model calls unless exactly "1". */
  enabled?: string;
  /** Local-only Ollama model name, never a URL or external provider token. */
  modelId?: string;
  /** Separate owner opt-in before making any additional model calls for checkpoints. */
  composeEnabled?: string;
};

/**
 * Preserve the shipping deterministic planner registry unless owner has
 * explicitly opted in to a fixed-loopback, read-only-metadata subgoal ranker.
 * This configuration does NOT auto-approve actions or enable model-proposal HTTP.
 */
export function optionalLocalModelPlanners(config: LocalModelOptIn): TaskPlanner[] | undefined {
  const enabled = config.enabled;
  if (config.composeEnabled !== undefined && !['', '0', '1'].includes(config.composeEnabled)) {
    throw new OperatorError('TASK_MODEL_CONFIG_INVALID', 'Dynamic composition requires exact opt-in 1 or disabled 0.');
  }
  if (config.composeEnabled === '1' && enabled !== '1') {
    throw new OperatorError('TASK_MODEL_CONFIG_INVALID', 'Dynamic composition requires separate local model planning opt-in.');
  }
  if (enabled === undefined || enabled === '' || enabled === '0') {
    if (config.modelId) {
      throw new OperatorError('TASK_MODEL_CONFIG_INVALID',
        'A local model was specified without the independent explicit opt-in flag.');
    }
    return undefined;
  }
  if (enabled !== '1' || typeof config.modelId !== 'string' || !config.modelId) {
    throw new OperatorError('TASK_MODEL_CONFIG_INVALID',
      'Opt-in to a fixed-loopback model requires exact enabled=1 and a valid local model identifier.');
  }
  // A configured name is never treated as a URL or arbitrary network
  // destination, even though the underlying provider uses fixed loopback.
  if (config.modelId.includes('://') || config.modelId.startsWith('/')) {
    throw new OperatorError('TASK_MODEL_CONFIG_INVALID',
      'Local subgoal model must be a name, not a URL or filesystem path.');
  }
  return [
    new ProjectQualityGatePlanner(),
    new SemanticTaskPlanner(),
    new SemanticWorkflowPlanner(),
    new LocalModelAutonomousWorkflowPlanner({ model: config.modelId,
      enableLoopbackComposition: config.composeEnabled === '1' })
  ];
}
