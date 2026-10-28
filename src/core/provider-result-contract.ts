import type { ActionRequest, ActionResult, ProviderReconciliationResult } from './types.ts';
import { OperatorError } from './errors.ts';

/**
 * A provider is a less-trusted execution boundary: getters and sparse arrays
 * must never be treated as receipts or executed while validating evidence.
 * Validate own data descriptors before reading ANY authority-bearing fields.
 */
function inertReceiptRecord(value: unknown, reject: () => never): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
       Object.getPrototypeOf(value) !== null)) reject();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !descriptor.enumerable ||
        !('value' in descriptor)) reject();
  }
  return value as Record<string, unknown>;
}

function inertEvidenceArray(value: unknown, reject: () => never): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 256 ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1) reject();
  const entries: Record<string, unknown>[] = [];
  for (let index = 0; index < value.length; index++) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item || !item.enumerable || !('value' in item)) reject();
    entries.push(inertReceiptRecord(item.value, reject));
  }
  return entries;
}

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
  const result = inertReceiptRecord(input, reject);
  const receipts = inertEvidenceArray(result.evidence, reject);
  if (typeof action.capability !== 'string' || typeof providerName !== 'string' ||
      result.capability !== action.capability || result.provider !== providerName ||
      typeof result.ok !== 'boolean' ||
      typeof result.durationMs !== 'number' ||
      !Number.isFinite(result.durationMs) || result.durationMs < 0 ||
      result.durationMs > 24 * 60 * 60_000 ||
      !Array.isArray(result.evidence) || result.evidence.length > 256) reject();

  for (const evidence of receipts) {
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
    const error = inertReceiptRecord(result.error, reject);
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

/**
 * Provider reconciliation is an authority-bearing observation, not a trusted
 * promise. A bogus "completed" reply must not release quarantine on an action
 * whose actual result is absent or refers to another provider/capability.
 */
export function assertProviderReconciliationContract(
  input: unknown,
  action: Pick<ActionRequest, 'capability'>,
  providerName: string
): ProviderReconciliationResult {
  const reject = (): never => {
    throw new OperatorError('PROVIDER_RECONCILIATION_CONTRACT_INVALID',
      'Provider reconciliation did not establish a valid source-bound outcome.', {
        retryable: false,
        details: { executionPhase: 'reconciled', sideEffectState: 'uncertain' }
      });
  };
  const value = inertReceiptRecord(input, reject);
  inertEvidenceArray(value.evidence, reject);
  if (!['completed','not_applied','uncertain'].includes(value.status as string) ||
      !Array.isArray(value.evidence) || value.evidence.length > 256) reject();

  // Reuse the exact same receipt shape and canonical timestamp checks as
  // normal action results, including the no-coercion provider identity rule.
  try {
    assertProviderResultContract({
      ok: true, capability: action.capability, provider: providerName,
      durationMs: 0, evidence: value.evidence
    }, action, providerName);
  } catch { reject(); }

  if (value.status === 'completed') {
    if (value.result === undefined) reject();
    let result: ActionResult;
    try { result = assertProviderResultContract(value.result, action, providerName); }
    catch { reject(); }
    if (!result!.ok) reject();
  } else if (value.result !== undefined) {
    // Failure/uncertainty cannot smuggle a success receipt for another action.
    reject();
  }
  return input as ProviderReconciliationResult;
}
