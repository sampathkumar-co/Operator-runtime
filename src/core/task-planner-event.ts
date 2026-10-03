import type { ActionResult } from './types.ts';
import type { TaskFailureDecision } from './task-failure.ts';

export type PlannerEventKind =
  | 'STALE_TARGET'
  | 'AMBIGUOUS_TARGET'
  | 'ACTION_SUCCEEDED_BUT_NO_PROGRESS'
  | 'SETTLE_TIMEOUT'
  | 'UI_CHANGED'
  | 'RESOURCE_BUSY'
  | 'STATE_CHANGED'
  | 'RECONCILIATION_REQUIRED'
  | 'PROVIDER_TEMPORARILY_UNAVAILABLE';

export type PlannerEventDecision = 'REOBSERVE' | 'REPLAN' | 'REPAIR' | 'RECONCILE' | 'WAIT' | 'FAIL';

export interface TaskPlannerEvent {
  kind: PlannerEventKind;
  decision: PlannerEventDecision;
  code: string;
  at: string;
  provider: string;
  capability: string;
  settled?: boolean;
  elapsedMs?: number;
  reason?: string;
  lastMutationVersion?: number;
  busy?: number;
  dialogs?: number;
  deltaSummary?: { progress: boolean; repeatedNoProgress: number };
}

export function plannerEventFromResult(result: ActionResult, failure?: TaskFailureDecision): TaskPlannerEvent | undefined {
  const at = new Date().toISOString();
  const output = asRecord(result.output);
  const settle = asRecord(output.settle);
  const delta = asRecord(output.stateDelta);
  if (result.ok && delta.progress === false) {
    return {
      kind: 'ACTION_SUCCEEDED_BUT_NO_PROGRESS', decision: 'REPLAN', code: 'ACTION_SUCCEEDED_BUT_NO_PROGRESS',
      at, provider: result.provider, capability: result.capability,
      deltaSummary: { progress: false, repeatedNoProgress: safeInteger(delta.repeatedNoProgress) }
    };
  }
  if (result.ok && settle.settled === false) {
    return {
      kind: 'SETTLE_TIMEOUT', decision: 'REOBSERVE', code: 'BROWSER_SETTLE_TIMEOUT',
      at, provider: result.provider, capability: result.capability, settled: false,
      elapsedMs: safeInteger(settle.elapsedMs), reason: safeText(settle.reason),
      lastMutationVersion: safeInteger(settle.lastMutationVersion), busy: safeInteger(settle.busy), dialogs: safeInteger(settle.dialogs)
    };
  }
  if (result.ok || !result.error) return undefined;
  const code = result.error.code;
  const upper = code.toUpperCase();
  const kind: PlannerEventKind = /AMBIGUOUS|NOT_UNIQUE/.test(upper) ? 'AMBIGUOUS_TARGET'
    : /NO_PROGRESS/.test(upper) ? 'ACTION_SUCCEEDED_BUT_NO_PROGRESS'
      : /SETTLE.*TIMEOUT/.test(upper) ? 'SETTLE_TIMEOUT'
        : /RESOURCE.*BUSY|LOCK_BUSY/.test(upper) ? 'RESOURCE_BUSY'
          : /RECONCIL/.test(upper) || result.error.sideEffectState === 'uncertain' ? 'RECONCILIATION_REQUIRED'
            : /STATE_CHANGED|FINGERPRINT|PRECONDITION/.test(upper) ? 'STATE_CHANGED'
              : /STALE|TARGET_NOT_FOUND|ELEMENT_NOT_FOUND/.test(upper) ? 'STALE_TARGET'
                : /TEMPORARY|UNAVAILABLE|OFFLINE|CONNECTION|RATE_LIMIT/.test(upper) ? 'PROVIDER_TEMPORARILY_UNAVAILABLE'
                  : 'UI_CHANGED';
  const decision = failure ? strategyDecision(failure.strategy) : 'FAIL';
  return { kind, decision, code, at, provider: result.provider, capability: result.capability, reason: result.error.message.slice(0, 1024) };
}

function strategyDecision(strategy: TaskFailureDecision['strategy']): PlannerEventDecision {
  if (strategy === 'reobserve') return 'REOBSERVE';
  if (strategy === 'replan') return 'REPLAN';
  if (strategy === 'repair' || strategy === 'retry') return 'REPAIR';
  if (strategy === 'reconcile') return 'RECONCILE';
  if (strategy === 'block') return 'WAIT';
  return 'FAIL';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function safeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
function safeText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 1024) : undefined;
}
