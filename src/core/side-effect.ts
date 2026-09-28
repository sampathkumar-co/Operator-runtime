import type { ActionResult, ActionRisk, SideEffectState } from './types.ts';
import { OperatorError } from './errors.ts';

export function validSideEffectState(value: unknown): SideEffectState {
  if (value === 'none' || value === 'known' || value === 'uncertain') return value;
  throw new OperatorError('SIDE_EFFECT_STATE_INVALID', 'Side-effect state must be none, known, or uncertain.');
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
