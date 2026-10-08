import type { ActionResult } from './types.ts';
import { epistemicStatusFromResult } from './epistemic-state.ts';

type ActionError = NonNullable<ActionResult['error']>;

export type TaskFailureClass =
  | 'approval'
  | 'cancelled'
  | 'stale-state'
  | 'target-drift'
  | 'transient'
  | 'policy'
  | 'postcondition'
  | 'permanent'
  | 'unknown';

export type TaskFailureStrategy =
  | 'block'
  | 'cancel'
  | 'reobserve'
  | 'repair'
  | 'replan'
  | 'reconcile'
  | 'retry'
  | 'fail';

export interface TaskFailureDecision {
  class: TaskFailureClass;
  strategy: TaskFailureStrategy;
  retryable: boolean;
  code: string;
}

/**
 * Central, deterministic failure taxonomy for the autonomous loop.
 * It never expands authority: the strategy only decides whether the planner
 * may re-observe/retry/repair through the same policy + approval boundary.
 */
export function classifyTaskFailure(error: ActionError | undefined): TaskFailureDecision {
  const code = error?.code ?? 'EXECUTION_FAILED';
  const epistemic = epistemicStatusFromResult({ ok: false, error });
  if (code === 'APPROVAL_REQUIRED' || code === 'APPROVAL_EXPIRED') {
    return { class: 'approval', strategy: 'block', retryable: false, code };
  }
  if (code === 'EXECUTION_ABORTED' || code === 'TASK_CANCELLED') {
    return { class: 'cancelled', strategy: 'cancel', retryable: false, code };
  }
  // Authority and scope denials outrank provider retry hints and ambiguous metadata.
  if (/POLICY|SCOPE|DENIED|NOT_ALLOWED|RESTRICTED|UNAUTHORIZED|RISK_MISMATCH|EMERGENCY|AUTHORITY/i.test(code)) {
    return { class: 'policy', strategy: 'fail', retryable: false, code };
  }
  if (/NO_PROGRESS/i.test(code)) {
    return { class: 'postcondition', strategy: 'replan', retryable: false, code };
  }
  if (epistemic === 'AMBIGUOUS') {
    return {
      class: 'target-drift',
      strategy: error?.executionPhase === 'pre_dispatch' || error?.sideEffectState === 'none' || error?.executionPhase === undefined ? 'reobserve' : 'reconcile',
      retryable: true,
      code
    };
  }
  if (/PRECONDITION|STATE_CHANGED|FINGERPRINT|STALE|TARGET_NOT_FOUND|TARGET_NOT_SCROLLABLE|ELEMENT_NOT_FOUND|WAIT_TIMEOUT/i.test(code)) {
    return {
      class: 'stale-state',
      strategy: error?.executionPhase === 'pre_dispatch' ? 'reobserve' : error?.sideEffectState === 'none' ? 'repair' : 'reconcile',
      retryable: true,
      code
    };
  }
  if (/POSTCONDITION|VERIFY|VERIFICATION/i.test(code)) {
    return { class: 'postcondition', strategy: 'fail', retryable: false, code };
  }
  if (/ARTIFACT.*MISMATCH/i.test(code)) {
    return error?.sideEffectState === 'none'
      ? { class: 'target-drift', strategy: 'repair', retryable: true, code }
      : { class: 'postcondition', strategy: 'fail', retryable: false, code };
  }
  if (/TARGET_EXISTS|CONTENT_MISMATCH/i.test(code)) {
    return { class: 'target-drift', strategy: 'repair', retryable: true, code };
  }
  if (/TIMEOUT|TEMPORARY|UNAVAILABLE|OFFLINE|CONNECTION|RELAY_RESULT_PENDING|RATE_LIMIT|BUSY/i.test(code) || error?.retryable === true) {
    return {
      class: 'transient',
      strategy: error?.sideEffectState === 'uncertain' ? 'reconcile' : 'retry',
      retryable: true,
      code
    };
  }
  if (epistemic === 'UNKNOWN') {
    if (error?.retryable === false) return { class: 'permanent', strategy: 'fail', retryable: false, code };
    return { class: 'unknown', strategy: error?.sideEffectState === 'uncertain' ? 'reconcile' : 'reobserve', retryable: true, code };
  }
  if (error) return { class: 'permanent', strategy: 'fail', retryable: false, code };
  return { class: 'unknown', strategy: 'fail', retryable: false, code };
}
