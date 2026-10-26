import type { ActionRequest, ActionResult } from './types.ts';
import { OperatorError } from './errors.ts';

/**
 * Verify the result returned by a leaf provider before the router can treat it
 * as proof of a completed user action. This is independent from the provider's
 * own support and schema implementation. A provider bug must not be converted
 * into success by the central dispatch kernel.
 *
 * The provider has already been called. If its contract cannot be verified,
 * the side-effect state is UNCERTAIN rather than claiming pre-dispatch denial.
 */
export function assertProviderResultContract(
  input: unknown, action: Pick<ActionRequest, 'capability'>, providerName: string
): ActionResult {
  const reject = (): never => {
    throw new OperatorError('PROVIDER_RESULT_CONTRACT_INVALID',
      'Provider response failed the required action identity or result contract.', {
        retryable: false,
        details: { executionPhase: 'dispatched', sideEffectState: 'uncertain' }
      });
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject();
  const result = input as Record<string, unknown>;
  if (typeof action.capability !== 'string' || typeof providerName !== 'string' ||
      result.capability !== action.capability || result.provider !== providerName ||
      typeof result.ok !== 'boolean' ||
      typeof result.durationMs !== 'number' ||
      !Number.isFinite(result.durationMs) || result.durationMs < 0 ||
      result.durationMs > 24 * 60 * 60_000 ||
      !Array.isArray(result.evidence) || result.evidence.length > 256) reject();

  for (const entry of result.evidence as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) reject();
    const evidence = entry as Record<string, unknown>;
    if (typeof evidence.kind !== 'string' || !evidence.kind ||
        evidence.kind.length > 128 ||
        (typeof evidence.status !== 'string' || !['pass','fail','info'].includes(evidence.status)) ||
        typeof evidence.message !== 'string' ||
        evidence.message.length > 8192 ||
        typeof evidence.timestamp !== 'string' ||
        !Number.isFinite(Date.parse(evidence.timestamp)) ||
        new Date(evidence.timestamp).toISOString() !== evidence.timestamp) reject();
  }

  if (result.ok === true && result.error !== undefined) reject();
  if (result.error !== undefined) {
    if (!result.error || typeof result.error !== 'object' || Array.isArray(result.error)) reject();
    const error = result.error as Record<string, unknown>;
    if (typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]{1,127}$/.test(error.code) ||
        typeof error.message !== 'string' || error.message.length > 8192 ||
        (error.retryable !== undefined && typeof error.retryable !== 'boolean')) reject();
    if (error.sideEffectState !== undefined &&
        (typeof error.sideEffectState !== 'string' || !['none','known','uncertain'].includes(error.sideEffectState))) reject();
    if (error.executionPhase !== undefined &&
        (typeof error.executionPhase !== 'string' || !['pre_dispatch','dispatched','effect_observed','reconciled'].includes(error.executionPhase))) reject();
  }
  return input as ActionResult;
}
