/**
 * Emergency access to original-device owner review after an exact relay
 * authority conflict. Never treats a failed relay as authority to replay.
 */
const AUTHORITY_CONFLICT = 'RELAY_AUTHORITY_CONFLICT_REVIEW_REQUIRED';

export function isOriginalAuthorityConflict(status: unknown, error?: unknown): boolean {
  // The relay client's final SHUTTING_DOWN state can replace DEGRADED before
  // the required-relay catch executes. Only a real typed error carrying the
  // *exact* native authority-conflict code is an alternative proof.
  if (error instanceof Error && (error as Error & { code?: unknown }).code === AUTHORITY_CONFLICT) {
    return true;
  }
  if (!status || typeof status !== 'object' || Array.isArray(status)) return false;
  const entry = status as Record<string, unknown>;
  return entry.state === 'DEGRADED' &&
    entry.code === AUTHORITY_CONFLICT &&
    entry.recoverable !== true;
}

const RECOVERY_ONLY_ROUTES = new Set([
  'GET /health',
  'GET /control-center',
  'POST /v1/control-center/browser-login/code',
  'POST /v1/control-center/browser-login/windows',
  'POST /v1/control-center/browser-login',
  'POST /v1/control-center/browser-logout',
  'GET /v1/control-center/status',
  'GET /v1/control-center/runtime',
  'GET /v1/control-center/original-recovery/browser',
  'POST /v1/control-center/original-recovery/browser/resolve',
  'GET /v1/control-center/original-recovery'
]);

/** Every other route, including ordinary read/execute/reset, fails closed. */
export function originalRecoveryOnlyRouteAllowed(method: string, pathname: string): boolean {
  return RECOVERY_ONLY_ROUTES.has(method + ' ' + pathname);
}
