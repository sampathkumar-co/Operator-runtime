/**
 * C10 verified doctor observation boundary.
 *
 * The control-center server being reachable does not prove the independent
 * CLI doctor passed. Only a trusted in-process probe may supply this evidence;
 * HTTP JSON, a browser cookie or user-supplied settings cannot.
 */
export interface DoctorObservation {
  passed: boolean;
  observedAt: string;
  productVersion: string;
}
export interface DoctorOnboardingEvidence {
  healthy: boolean;
  status: 'PASS' | 'FAILED' | 'UNVERIFIED' | 'STALE' | 'VERSION_MISMATCH';
  source: 'TRUSTED_DOCTOR_PROBE' | 'NONE';
}
const MAX_AGE_MS = 5 * 60_000;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
export function projectDoctorOnboardingEvidence(
  raw: unknown, expectedVersion: string, now: Date = new Date()
): DoctorOnboardingEvidence {
  const unknown: DoctorOnboardingEvidence = { healthy: false, status: 'UNVERIFIED', source: 'NONE' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unknown;
  const observed = raw as Partial<DoctorObservation>;
  if (typeof observed.passed !== 'boolean' ||
      typeof observed.observedAt !== 'string' ||
      !ISO.test(observed.observedAt) ||
      !Number.isFinite(Date.parse(observed.observedAt)) ||
      new Date(observed.observedAt).toISOString() !== observed.observedAt ||
      typeof observed.productVersion !== 'string') return unknown;
  if (observed.productVersion !== expectedVersion) {
    return { healthy: false, status: 'VERSION_MISMATCH', source: 'TRUSTED_DOCTOR_PROBE' };
  }
  const ageMs = now.getTime() - Date.parse(observed.observedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > MAX_AGE_MS) {
    return { healthy: false, status: 'STALE', source: 'TRUSTED_DOCTOR_PROBE' };
  }
  return {
    healthy: observed.passed,
    status: observed.passed ? 'PASS' : 'FAILED',
    source: 'TRUSTED_DOCTOR_PROBE'
  };
}
