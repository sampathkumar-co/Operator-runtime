import type { ActionRequest, ActionResult, ProviderReconciliationResult, RecoveryRemedy } from './types.ts';
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

const RESULT_FIELDS = new Set(['ok', 'capability', 'provider', 'output', 'evidence', 'error', 'durationMs']);
const EVIDENCE_FIELDS = new Set(['kind', 'status', 'message', 'data', 'timestamp']);
const ERROR_FIELDS = new Set([
  'code', 'message', 'retryable', 'sideEffectState', 'executionPhase', 'epistemicStatus', 'details'
]);
const RECONCILIATION_FIELDS = new Set(['status', 'result', 'evidence']);
const RECOVERY_REMEDIES = new Set<RecoveryRemedy>([
  'reobserve_before_retry',
  'reobserve_dialog_do_not_retry',
  'reobserve_tab_focus_before_retry',
  'select_page_target',
  'select_target_id_from_current_tabs',
  'close_the_dialog_manually_then_reobserve'
]);

function exactFields(record: Record<string, unknown>, allowed: ReadonlySet<string>, reject: () => never): void {
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || !allowed.has(key)) reject();
  }
}

/** Provider-owned payloads cross a trust boundary. Permit bounded JSON data,
 * but never accessors, custom prototypes, sparse arrays, symbols or cycles. */
function inertJson(value: unknown, reject: () => never): void {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 20_000 || depth > 32) reject();
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) reject(); return; }
    if (typeof item !== 'object') reject();
    if (seen.has(item as object)) reject();
    seen.add(item as object);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 10_000 ||
          Reflect.ownKeys(item).length !== item.length + 1) reject();
      for (let index = 0; index < item.length; index++) {
        const field = Object.getOwnPropertyDescriptor(item, String(index));
        if (!field || !field.enumerable || !('value' in field)) reject();
        visit(field.value, depth + 1);
      }
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) reject();
      if (Reflect.ownKeys(item).length > 10_000) reject();
      for (const key of Reflect.ownKeys(item)) {
        const field = Object.getOwnPropertyDescriptor(item, key);
        if (typeof key !== 'string' || !field || !field.enumerable || !('value' in field)) reject();
        visit(field.value, depth + 1);
      }
    }
    seen.delete(item as object);
  };
  visit(value, 0);
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
  exactFields(result, RESULT_FIELDS, reject);
  const receipts = inertEvidenceArray(result.evidence, reject);
  if (typeof action.capability !== 'string' || typeof providerName !== 'string' ||
      result.capability !== action.capability || result.provider !== providerName ||
      typeof result.ok !== 'boolean' ||
      typeof result.durationMs !== 'number' ||
      !Number.isFinite(result.durationMs) || result.durationMs < 0 ||
      result.durationMs > 24 * 60 * 60_000 ||
      !Array.isArray(result.evidence) || result.evidence.length > 256) reject();

  for (const evidence of receipts) {
    exactFields(evidence, EVIDENCE_FIELDS, reject);
    if (typeof evidence.kind !== 'string' || !evidence.kind ||
        evidence.kind.length > 128 ||
        (typeof evidence.status !== 'string' || !['pass','fail','info'].includes(evidence.status)) ||
        typeof evidence.message !== 'string' ||
        evidence.message.length > 8192 ||
        typeof evidence.timestamp !== 'string' ||
        !Number.isFinite(Date.parse(evidence.timestamp)) ||
        new Date(evidence.timestamp).toISOString() !== evidence.timestamp) reject();
    if (evidence.data !== undefined) inertJson(evidence.data, reject);
  }

  if (result.output !== undefined) inertJson(result.output, reject);

  if (result.ok === true && result.error !== undefined) reject();
  if (result.error !== undefined) {
    const error = inertReceiptRecord(result.error, reject);
    exactFields(error, ERROR_FIELDS, reject);
    if (typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]{1,127}$/.test(error.code) ||
        typeof error.message !== 'string' || error.message.length > 8192 ||
        (error.retryable !== undefined && typeof error.retryable !== 'boolean')) reject();
    if (error.sideEffectState !== undefined &&
        (typeof error.sideEffectState !== 'string' || !['none','known','uncertain'].includes(error.sideEffectState))) reject();
    if (error.executionPhase !== undefined &&
        (typeof error.executionPhase !== 'string' || !['pre_dispatch','dispatched','effect_observed','reconciled'].includes(error.executionPhase))) reject();
    if (error.epistemicStatus !== undefined &&
        (typeof error.epistemicStatus !== 'string' || !['UNKNOWN','AMBIGUOUS','CONTRADICTED','UNAVAILABLE','UNAUTHORIZED','EXECUTION_UNCERTAIN','VERIFIED_FALSE'].includes(error.epistemicStatus))) reject();
    if (error.retryable === true && error.sideEffectState === 'uncertain') reject();
    if (error.details !== undefined) {
      inertJson(error.details, reject);
      const details = error.details as Record<string, unknown>;
      if (details.remedy !== undefined &&
          (typeof details.remedy !== 'string' || !RECOVERY_REMEDIES.has(details.remedy as RecoveryRemedy))) reject();
    }
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
  exactFields(value, RECONCILIATION_FIELDS, reject);
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
