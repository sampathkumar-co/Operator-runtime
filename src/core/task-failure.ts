import type { ActionResult } from './types.ts';

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
  if (code === 'APPROVAL_REQUIRED' || code === 'APPROVAL_EXPIRED') {
    return { class: 'approval', strategy: 'block', retryable: false, code };
  }
  if (code === 'EXECUTION_ABORTED' || code === 'TASK_CANCELLED') {
    return { class: 'cancelled', strategy: 'cancel', retryable: false, code };
  }
  if (/PRECONDITION|STATE_CHANGED|FINGERPRINT|STALE|TARGET_NOT_FOUND|ELEMENT_NOT_FOUND|WAIT_TIMEOUT|TARGET_NOT_UNIQUE|AMBIGUOUS/i.test(code)) {
    return { class: 'stale-state', strategy: 'reobserve', retryable: true, code };
  }
  if (/TARGET_EXISTS|CONTENT_MISMATCH|POSTCONDITION|ARTIFACT.*MISMATCH/i.test(code)) {
    return { class: 'target-drift', strategy: 'repair', retryable: true, code };
  }
  if (/TIMEOUT|TEMPORARY|UNAVAILABLE|OFFLINE|CONNECTION|RELAY_RESULT_PENDING|RATE_LIMIT|BUSY/i.test(code) || error?.retryable === true) {
    return { class: 'transient', strategy: 'retry', retryable: true, code };
  }
  if (/POLICY|SCOPE|DENIED|NOT_ALLOWED|RESTRICTED|UNAUTHORIZED|RISK_MISMATCH|EMERGENCY/i.test(code)) {
    return { class: 'policy', strategy: 'fail', retryable: false, code };
  }
  if (/POSTCONDITION|VERIFY|VERIFICATION/i.test(code)) {
    return { class: 'postcondition', strategy: 'fail', retryable: false, code };
  }
  if (error) return { class: 'permanent', strategy: 'fail', retryable: false, code };
  return { class: 'unknown', strategy: 'fail', retryable: false, code };
}
