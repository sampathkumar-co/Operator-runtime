import type { ActionResult, EpistemicStatus } from './types.ts';

/** One cross-layer vocabulary for what the runtime knows about an action outcome. */
export function epistemicStatusFromResult(result: Pick<ActionResult, 'ok' | 'error'>): EpistemicStatus {
  if (result.ok) return 'KNOWN';
  const explicit = result.error?.epistemicStatus;
  if (explicit) return explicit;
  const code = (result.error?.code ?? '').toUpperCase();
  if (result.error?.sideEffectState === 'uncertain') return 'EXECUTION_UNCERTAIN';
  if (/UNAUTHORIZED|DENIED|OUTSIDE_SCOPE|NOT_ALLOWED|RESTRICTED|AUTHORITY|APPROVAL/.test(code)) return 'UNAUTHORIZED';
  if (/AMBIGUOUS|MULTIPLE_MATCH|NOT_UNIQUE/.test(code)) return 'AMBIGUOUS';
  if (/CONTRADICT|STATE_CHANGED|FINGERPRINT|CONFLICT|STALE_EVIDENCE/.test(code)) return 'CONTRADICTED';
  if (/UNAVAILABLE|OFFLINE|CONNECTION|RATE_LIMIT|BUSY|WAIT_TIMEOUT|TIMEOUT/.test(code)) return 'UNAVAILABLE';
  if (/POSTCONDITION|VERIFY|VERIFICATION|MISMATCH|NO_PROGRESS/.test(code)) return 'VERIFIED_FALSE';
  return 'UNKNOWN';
}

export function epistemicReasonFromResult(result: Pick<ActionResult, 'ok' | 'error'>): string {
  return result.ok ? 'ACTION_RESULT_KNOWN' : (result.error?.code || 'OUTCOME_UNKNOWN').slice(0, 128);
}
