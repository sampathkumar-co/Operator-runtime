import type { ActionResult, ActionRisk, ExecutionPhase, SideEffectState } from './types.ts';
import { OperatorError } from './errors.ts';

export function validSideEffectState(value: unknown): SideEffectState {
  if (value === 'none' || value === 'known' || value === 'uncertain') return value;
  throw new OperatorError('SIDE_EFFECT_STATE_INVALID', 'Side-effect state must be none, known, or uncertain.');
}

export function validExecutionPhase(value: unknown): ExecutionPhase {
  if (value === 'pre_dispatch' || value === 'dispatched' || value === 'effect_observed' || value === 'reconciled') return value;
  throw new OperatorError('EXECUTION_PHASE_INVALID', 'Execution phase must be pre_dispatch, dispatched, effect_observed, or reconciled.');
}

export function conservativeExecutionPhase(result: ActionResult): ExecutionPhase {
  if (result.ok) return 'effect_observed';
  if (result.error?.executionPhase !== undefined) return validExecutionPhase(result.error.executionPhase);
  try {
    if (result.error?.details?.executionPhase !== undefined) return validExecutionPhase(result.error.details.executionPhase);
  } catch {
    // Malformed provider metadata cannot prove that native dispatch did not begin.
  }
  if (result.provider === 'policy' || result.provider === 'router') return 'pre_dispatch';
  return 'dispatched';
}

/**
 * Fail-closed side-effect classification.
 *
 * Read actions never mutate. Successful mutating actions have a known effect.
 * Policy/router failures occur before provider execution. Any other failed
 * mutation is uncertain unless a trusted provider explicitly reports otherwise.
 */
export function conservativeSideEffectState(risk: ActionRisk, result: ActionResult): SideEffectState {
  if (risk === 'read') return 'none';
  if (conservativeExecutionPhase(result) === 'pre_dispatch') return 'none';
  if (result.ok) return 'known';
  if (result.error?.sideEffectState !== undefined) return validSideEffectState(result.error.sideEffectState);
  if (result.provider === 'policy' || result.provider === 'router') return 'none';
  return 'uncertain';
}

export function retrySafeWithoutReconciliation(risk: ActionRisk, state: SideEffectState): boolean {
  return risk === 'read' || state === 'none';
}

export function requiresReconciliation(risk: ActionRisk, state: SideEffectState): boolean {
  return risk !== 'read' && state === 'uncertain';
}
