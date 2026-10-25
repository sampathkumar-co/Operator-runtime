import crypto from 'node:crypto';
import { OperatorError } from './errors.ts';

const ISSUE_CODES = new Set([
  'RECOVERY_NOT_CONFIGURED', 'DEVICE_IDENTITY_MISSING',
  'NO_AUTHORIZED_ROOTS', 'EMERGENCY_STOP_ENGAGED',
  'RELAY_DEGRADED', 'APPROVALS_PENDING'
]);
const TASK_STATES = ['PENDING','RUNNING','PAUSED','BLOCKED','VERIFYING',
  'VERIFIED','FAILED','CANCELLED','CANCELED','UNKNOWN','RECOVERING'] as const;
const APPROVAL_STATES = ['pending','approved','inUse','consumed','denied','expired'] as const;
const MAX_COUNTER = 1_000_000;

function corrupt(reason: string): never {
  throw new OperatorError('CONTROL_CENTER_EXPORT_INVALID',
    'Cannot create safe diagnostics: ' + reason);
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 ||
      Number(value) > MAX_COUNTER) {
    corrupt('unexpected untrusted counter; no bundle was generated');
  }
  return value as number;
}
function counters(input: unknown, keys: readonly string[]): Record<string,number> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    corrupt('counter collection unavailable');
  }
  const values = input as Record<string,unknown>;
  const result: Record<string,number> = Object.create(null) as Record<string,number>;
  for (const key of keys) result[key] = count(values[key] ?? 0);
  return result;
}

export interface SafeControlCenterDiagnosticExport {
  schemaVersion: 1;
  kind: 'MECORD_SAFE_DIAGNOSTIC_EXPORT';
  generatedAt: string;
  service: 'operator-local-agent';
  productVersion: string;
  configuration: {
    emergencyStopped: boolean;
    recoveryConfigured: boolean;
    deviceConfigured: boolean;
    authorizedRootCount: number;
  };
  peerCounts: Record<string,number>;
  taskCounts: Record<string,number>;
  approvalCounts: Record<string,number>;
  issueCodes: string[];
  source: 'LOCAL_AUTHENTICATED_CONTROL_CENTER';
  redaction: {
    mode: 'STRICT_FIXED_ALLOWLIST';
    omitted: string[];
    originalReceipts: 'NOT_EXPORTED';
    deviceNames: 'NOT_EXPORTED';
    filesystemPaths: 'NOT_EXPORTED';
    accessTokens: 'NOT_EXPORTED';
  };
  sha256: string;
}

/**
 * New allowlisted JSON bundle, NEVER a redaction pass over a raw runtime dump.
 * No sensitive dynamic strings from task summaries, device names, actions,
 * approval targets, receipts, arbitrary errors or relay status are copied.
 * Fixed shape/codes prevent free-form user-controlled strings leaking.
 */
export function buildSafeControlCenterDiagnosticExport(
  input: unknown, at = new Date().toISOString()
): SafeControlCenterDiagnosticExport {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    corrupt('diagnostic projection missing');
  }
  const d = input as Record<string,unknown>;
  if (d.service !== 'operator-local-agent' ||
      d.schemaVersion !== 1 || typeof d.productVersion !== 'string' ||
      !/^[0-9]{1,4}(?:\.[0-9]{1,4}){2}(?:[-+][A-Za-z0-9.-]{1,50})?$/.test(d.productVersion) ||
      ![d.emergencyStopped,d.recoveryConfigured].every(x => typeof x === 'boolean') ||
      !d.device || typeof d.device !== 'object' ||
      Array.isArray(d.device) ||
      typeof (d.device as Record<string,unknown>).configured !== 'boolean' ||
      !Array.isArray(d.issues) || d.issues.length > 50 ||
      !Number.isFinite(Date.parse(at)) || at.length > 36) {
    corrupt('source metadata, device status or diagnostic issue format is invalid');
  }
  const issues = d.issues.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      corrupt('invalid issue record');
    }
    const code = (item as Record<string,unknown>).code;
    if (typeof code !== 'string' || !ISSUE_CODES.has(code)) {
      corrupt('unapproved issue classification');
    }
    return code;
  });
  const source = {
    schemaVersion: 1 as const,
    kind: 'MECORD_SAFE_DIAGNOSTIC_EXPORT' as const,
    generatedAt: at,
    service: 'operator-local-agent' as const,
    productVersion: d.productVersion,
    configuration: {
      emergencyStopped: d.emergencyStopped as boolean,
      recoveryConfigured: d.recoveryConfigured as boolean,
      deviceConfigured: (d.device as Record<string,boolean>).configured,
      authorizedRootCount: count(d.authorizedRootCount)
    },
    peerCounts: counters(d.peerCounts,['total','active','revoked']),
    taskCounts: counters(d.taskCounts,TASK_STATES),
    approvalCounts: counters(d.approvalCounts,APPROVAL_STATES),
    issueCodes: [...new Set(issues)].sort(),
    source: 'LOCAL_AUTHENTICATED_CONTROL_CENTER' as const,
    redaction: {
      mode: 'STRICT_FIXED_ALLOWLIST' as const,
      omitted: [
        'runtime','deviceName','deviceId','accountId','roots','paths',
        'tasks','taskIds','objectives','approvalRecords','approvalTargets',
        'originalReceipts','receiptPayloads','credentials','tokens','secrets',
        'browserState','userFiles','stackTraces','rawErrors','relayConnectionData'
      ],
      originalReceipts: 'NOT_EXPORTED' as const,
      deviceNames: 'NOT_EXPORTED' as const,
      filesystemPaths: 'NOT_EXPORTED' as const,
      accessTokens: 'NOT_EXPORTED' as const
    }
  };
  const serialized = JSON.stringify(source);
  if (Buffer.byteLength(serialized,'utf8') > 12 * 1024) {
    corrupt('output exceeds bounded diagnostic export');
  }
  return { ...source, sha256: crypto.createHash('sha256').update(serialized).digest('hex') };
}
