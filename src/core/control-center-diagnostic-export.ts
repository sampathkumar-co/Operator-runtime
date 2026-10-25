import crypto from 'node:crypto';

/**
 * Support exports are deliberately allowlisted. Do NOT "redact" by recursive
 * regex replacement: runtime/status objects may contain credentials, original
 * protected receipts, absolute paths, device identifiers or free-form notes.
 */
const ISSUE_CODES = new Set([
  'RECOVERY_NOT_CONFIGURED',
  'DEVICE_IDENTITY_MISSING',
  'NO_AUTHORIZED_ROOTS',
  'EMERGENCY_STOP_ENGAGED',
  'RELAY_DEGRADED',
  'APPROVALS_PENDING'
]);
const APPROVAL_KEYS = ['pending','approved','inUse','consumed','denied','expired'] as const;
const RELAY_STATES = new Set(['ONLINE','OFFLINE','DEGRADED','CONNECTED','DISCONNECTED','UNKNOWN']);
const STATE = Symbol('untrusted');

function object(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
}
function boundedNumber(input: unknown, max = 1_000_000): number | null {
  return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 &&
    input <= max ? input : null;
}
function exactVersion(input: unknown): string {
  return typeof input === 'string' && /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[A-Za-z0-9.-]{1,48})?$/.test(input)
    ? input : 'UNAVAILABLE';
}
function exactBool(input: unknown): boolean | null {
  return typeof input === 'boolean' ? input : null;
}

/**
 * Creates a small support artifact for an authenticated LOCAL Control Center
 * viewer. Every serialized field is constructed from known primitive values;
 * no arbitrary object keys, stack traces, usernames, tokens, device IDs,
 * root paths, task descriptions or raw receipt data are ever copied.
 *
 * A SHA256 digest is tamper-detection convenience, not a signature or a
 * trust/physical/release attestation.
 */
export function buildRedactedControlCenterDiagnostics(input: unknown, now: Date = new Date()) {
  const data = object(input);
  const runtime = object(data.runtime);
  const relay = object(runtime.relay);
  const approvals = object(data.approvalCounts);
  const peers = object(data.peerCounts);
  const tasks = object(data.taskCounts);
  const taskValues = Object.keys(tasks).length <= 50
    ? Object.values(tasks).map(v => boundedNumber(v, 100_000)) : [];
  const allTaskStatesValid = taskValues.length > 0 && taskValues.every(n => n !== null);
  const taskTotal = allTaskStatesValid
    ? taskValues.reduce<number>((sum, n) => sum + (n ?? 0), 0) : null;
  const relayState = typeof relay.state === 'string' && RELAY_STATES.has(relay.state)
    ? relay.state : 'UNKNOWN';
  const issues = Array.isArray(data.issues)
    ? [...new Set(data.issues.slice(0, 100)
      .map(v => object(v).code)
      .filter((v): v is string => typeof v === 'string' && ISSUE_CODES.has(v)))].sort()
    : [];
  const captureTime = Number.isFinite(now?.getTime()) ? now.toISOString() : null;
  const payload = {
    schemaVersion: 1,
    artifactKind: 'MECORD_REDACTED_LOCAL_SUPPORT_DIAGNOSTICS',
    exportTimeUtc: captureTime,
    productVersion: exactVersion(data.productVersion),
    localRuntime: {
      emergencyStopped: exactBool(data.emergencyStopped),
      recoveryAuthorityConfigured: exactBool(data.recoveryConfigured),
      authorizedRootCount: boundedNumber(data.authorizedRootCount, 10_000),
      relayState
    },
    fleetSummary: {
      total: boundedNumber(peers.total),
      active: boundedNumber(peers.active),
      revoked: boundedNumber(peers.revoked)
    },
    approvalSummary: Object.fromEntries(APPROVAL_KEYS.map(name =>
      [name, boundedNumber(approvals[name])])),
    taskSummary: {
      totalKnownStates: taskTotal !== null && taskTotal <= 1_000_000 ? taskTotal : null
    },
    issueCodes: issues,
    omittedByDesign: [
      'device identity, names and IP addresses',
      'authorization and browser session tokens',
      'account identifiers and file paths',
      'original task and approval payloads',
      'protected side-effect and recovery receipts',
      'raw runtime status and provider traces'
    ],
    physicalAcceptance: 'NOT_ATTESTED',
    releaseAuthorization: 'NOT_GRANTED'
  };
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, 'utf8') > 8192) {
    throw new Error('CONTROL_CENTER_EXPORT_OVERSIZED');
  }
  return {
    ...payload,
    sha256: crypto.createHash('sha256').update(body).digest('hex')
  };
}
