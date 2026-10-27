import { OperatorError } from '../../../src/core/errors.ts';
import { LoopbackOllamaPlanningInfluence } from '../../../src/core/local-model-planning-influence.ts';
import type { TaskPlanningInfluenceProvider } from '../../../src/core/task-orchestrator-contracts.ts';

export interface LocalAdvisoryModelOptIn {
  /** Literal "1" is required. Absent, empty or "0" means no model. */
  enabled?: string;
  /** An Ollama name/tag. URLs, path authorities and external tokens are forbidden. */
  modelId?: string;
}

/**
 * Pure runtime bootstrap configuration. An owner's local environment flag
 * permits ONLY an already-authorized veto on observed task events. The core
 * orchestrator still owns durable pre-request charging, Stop/Pause, digest
 * binding, canonical policy, approvals and all environment action execution.
 */
export function optionalLocalPlanningInfluence(
  config: LocalAdvisoryModelOptIn
): TaskPlanningInfluenceProvider | undefined {
  const enabled = config.enabled;
  if (enabled === undefined || enabled === '' || enabled === '0') {
    if (config.modelId !== undefined && config.modelId !== '') {
      throw new OperatorError('TASK_ADVISORY_CONFIG_INVALID',
        'Local advisory model cannot be selected without an explicit owner opt-in.');
    }
    return undefined;
  }
  if (enabled !== '1' || typeof config.modelId !== 'string' || !config.modelId) {
    throw new OperatorError('TASK_ADVISORY_CONFIG_INVALID',
      'Local advisory requires exact enabled=1 and a concrete bounded model name.');
  }
  if (config.modelId.includes('://') || config.modelId.startsWith('/') ||
      config.modelId.includes('\\') || config.modelId.includes('@')) {
    throw new OperatorError('TASK_ADVISORY_CONFIG_INVALID',
      'Local advisory selection must be an Ollama name/tag, never a URL, path or credential.');
  }
  try {
    return new LoopbackOllamaPlanningInfluence({ model: config.modelId });
  } catch {
    throw new OperatorError('TASK_ADVISORY_CONFIG_INVALID',
      'Local advisory model identifier is invalid.');
  }
}
