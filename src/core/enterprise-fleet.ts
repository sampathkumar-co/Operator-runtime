import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';

export interface EnterpriseFleetDevice {
  schemaVersion: 1;
  deviceId: string;
  deviceName: string;
  platform: 'win32' | 'linux' | 'darwin';
  arch: 'x64' | 'arm64';
  runtimeVersion: string;
  sourceCommit: string;
  updateChannel: 'canary' | 'beta' | 'stable';
  managed: boolean;
  secureBoot: boolean | 'unknown';
  diskEncryption: boolean | 'unknown';
  runtimeSignatureVerified: boolean;
  lastSeenAt: string;
  revoked: boolean;
  labels: string[];
}

export interface EnterpriseFleetPolicy {
  allowedPlatforms: EnterpriseFleetDevice['platform'][];
  minimumRuntimeVersion: string;
  allowedUpdateChannels: EnterpriseFleetDevice['updateChannel'][];
  requireManaged: boolean;
  requireSecureBoot: boolean;
  requireDiskEncryption: boolean;
  requireRuntimeSignature: boolean;
  maximumOfflineMs: number;
  allowedSourceCommits?: string[];
}

export interface EnterpriseFleetAssessment {
  schemaVersion: 1;
  id: string;
  deviceId: string;
  status: 'COMPLIANT' | 'NONCOMPLIANT' | 'OFFLINE' | 'REVOKED';
  executionEligible: boolean;
  reasons: string[];
  assessedAt: string;
}

export interface EnterpriseFleetSummary {
  schemaVersion: 1;
  total: number;
  compliant: number;
  noncompliant: number;
  offline: number;
  revoked: number;
  executionEligible: number;
  assessments: EnterpriseFleetAssessment[];
}

export function assessEnterpriseFleetDevice(input: {
  device: EnterpriseFleetDevice;
  policy: EnterpriseFleetPolicy;
  now?: string;
}): EnterpriseFleetAssessment {
  const device = normalizeDevice(input.device);
  const policy = normalizePolicy(input.policy);
  const assessedAt = iso(input.now ?? new Date().toISOString(), 'now');
  const reasons: string[] = [];

  if (device.revoked) reasons.push('DEVICE_REVOKED');
  if (!policy.allowedPlatforms.includes(device.platform)) reasons.push('PLATFORM_NOT_ALLOWED');
  if (compareSemver(device.runtimeVersion, policy.minimumRuntimeVersion) < 0) reasons.push('RUNTIME_VERSION_TOO_OLD');
  if (!policy.allowedUpdateChannels.includes(device.updateChannel)) reasons.push('UPDATE_CHANNEL_NOT_ALLOWED');
  if (policy.requireManaged && !device.managed) reasons.push('DEVICE_NOT_MANAGED');
  if (policy.requireSecureBoot && device.secureBoot !== true) reasons.push(device.secureBoot === 'unknown' ? 'SECURE_BOOT_UNKNOWN' : 'SECURE_BOOT_DISABLED');
  if (policy.requireDiskEncryption && device.diskEncryption !== true) reasons.push(device.diskEncryption === 'unknown' ? 'DISK_ENCRYPTION_UNKNOWN' : 'DISK_ENCRYPTION_DISABLED');
  if (policy.requireRuntimeSignature && !device.runtimeSignatureVerified) reasons.push('RUNTIME_SIGNATURE_UNVERIFIED');
  if (policy.allowedSourceCommits && !policy.allowedSourceCommits.includes(device.sourceCommit)) reasons.push('SOURCE_COMMIT_NOT_ALLOWED');

  const offline = Date.parse(assessedAt) - Date.parse(device.lastSeenAt) > policy.maximumOfflineMs;
  if (offline) reasons.push('DEVICE_OFFLINE');

  let status: EnterpriseFleetAssessment['status'];
  if (device.revoked) status = 'REVOKED';
  else if (offline) status = 'OFFLINE';
  else if (reasons.length > 0) status = 'NONCOMPLIANT';
  else status = 'COMPLIANT';

  const body = {
    schemaVersion: 1 as const,
    deviceId: device.deviceId,
    status,
    executionEligible: status === 'COMPLIANT',
    reasons: [...new Set(reasons)].sort(),
    assessedAt
  };
  return { ...body, id: sha256(canonicalJson(body)) };
}

export function summarizeEnterpriseFleet(input: {
  devices: EnterpriseFleetDevice[];
  policy: EnterpriseFleetPolicy;
  now?: string;
}): EnterpriseFleetSummary {
  if (!Array.isArray(input.devices) || input.devices.length > 100_000) throw invalid('Fleet device collection is invalid.');
  const ids = new Set<string>();
  const assessments = input.devices.map((device) => {
    const normalized = normalizeDevice(device);
    if (ids.has(normalized.deviceId)) throw invalid('Fleet contains duplicate device ids.');
    ids.add(normalized.deviceId);
    return assessEnterpriseFleetDevice({ device: normalized, policy: input.policy, now: input.now });
  }).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  return {
    schemaVersion: 1,
    total: assessments.length,
    compliant: assessments.filter((a) => a.status === 'COMPLIANT').length,
    noncompliant: assessments.filter((a) => a.status === 'NONCOMPLIANT').length,
    offline: assessments.filter((a) => a.status === 'OFFLINE').length,
    revoked: assessments.filter((a) => a.status === 'REVOKED').length,
    executionEligible: assessments.filter((a) => a.executionEligible).length,
    assessments
  };
}

function normalizeDevice(input: EnterpriseFleetDevice): EnterpriseFleetDevice {
  if (!input || input.schemaVersion !== 1) throw invalid('Fleet device is invalid.');
  if (!['win32','linux','darwin'].includes(input.platform) || !['x64','arm64'].includes(input.arch)) throw invalid('Fleet platform or architecture is invalid.');
  if (!['canary','beta','stable'].includes(input.updateChannel)) throw invalid('Fleet update channel is invalid.');
  for (const [label, value] of [['managed',input.managed],['runtimeSignatureVerified',input.runtimeSignatureVerified],['revoked',input.revoked]] as const) {
    if (typeof value !== 'boolean') throw invalid(label + ' must be boolean.');
  }
  for (const [label, value] of [['secureBoot',input.secureBoot],['diskEncryption',input.diskEncryption]] as const) {
    if (value !== true && value !== false && value !== 'unknown') throw invalid(label + ' is invalid.');
  }
  return {
    schemaVersion: 1,
    deviceId: id(input.deviceId, 'deviceId'),
    deviceName: text(input.deviceName, 256, 'deviceName'),
    platform: input.platform,
    arch: input.arch,
    runtimeVersion: semver(input.runtimeVersion),
    sourceCommit: commit(input.sourceCommit),
    updateChannel: input.updateChannel,
    managed: input.managed,
    secureBoot: input.secureBoot,
    diskEncryption: input.diskEncryption,
    runtimeSignatureVerified: input.runtimeSignatureVerified,
    lastSeenAt: iso(input.lastSeenAt, 'lastSeenAt'),
    revoked: input.revoked,
    labels: uniqueLabels(input.labels)
  };
}
function normalizePolicy(input: EnterpriseFleetPolicy): EnterpriseFleetPolicy {
  if (!input || typeof input !== 'object') throw invalid('Fleet policy is invalid.');
  const allowedPlatforms = [...new Set(input.allowedPlatforms ?? [])];
  if (allowedPlatforms.length < 1 || allowedPlatforms.some((v) => !['win32','linux','darwin'].includes(v))) throw invalid('allowedPlatforms is invalid.');
  const allowedUpdateChannels = [...new Set(input.allowedUpdateChannels ?? [])];
  if (allowedUpdateChannels.length < 1 || allowedUpdateChannels.some((v) => !['canary','beta','stable'].includes(v))) throw invalid('allowedUpdateChannels is invalid.');
  for (const [label, value] of [['requireManaged',input.requireManaged],['requireSecureBoot',input.requireSecureBoot],['requireDiskEncryption',input.requireDiskEncryption],['requireRuntimeSignature',input.requireRuntimeSignature]] as const) {
    if (typeof value !== 'boolean') throw invalid(label + ' must be boolean.');
  }
  return {
    allowedPlatforms: allowedPlatforms.sort() as EnterpriseFleetDevice['platform'][],
    minimumRuntimeVersion: semver(input.minimumRuntimeVersion),
    allowedUpdateChannels: allowedUpdateChannels.sort() as EnterpriseFleetDevice['updateChannel'][],
    requireManaged: input.requireManaged,
    requireSecureBoot: input.requireSecureBoot,
    requireDiskEncryption: input.requireDiskEncryption,
    requireRuntimeSignature: input.requireRuntimeSignature,
    maximumOfflineMs: integer(input.maximumOfflineMs, 1000, 30 * 24 * 60 * 60_000, 'maximumOfflineMs'),
    ...(input.allowedSourceCommits ? { allowedSourceCommits: [...new Set(input.allowedSourceCommits.map(commit))].sort() } : {})
  };
}
function compareSemver(left: string, right: string): number {
  const a = semver(left).split(/[.+-]/,3).slice(0,3).map(Number);
  const b = semver(right).split(/[.+-]/,3).slice(0,3).map(Number);
  for (let i=0;i<3;i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}
function semver(input: unknown): string {
  const value=String(input??'');
  if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) throw invalid('runtime version is invalid.');
  return value;
}
function uniqueLabels(input: unknown): string[] {
  if(!Array.isArray(input)||input.length>256) throw invalid('labels are invalid.');
  return [...new Set(input.map((v)=>id(v,'label'))) ].sort();
}
function id(input: unknown,label:string):string{const v=String(input??'');if(!/^[A-Za-z0-9._:@/+-=]{1,256}$/.test(v))throw invalid(label+' is invalid.');return v;}
function text(input:unknown,max:number,label:string):string{if(typeof input!=='string'||!input.trim()||input.includes('\0')||Buffer.byteLength(input,'utf8')>max)throw invalid(label+' is invalid.');return input.trim();}
function commit(input:unknown):string{const v=String(input??'').toLowerCase();if(!/^[0-9a-f]{40}$/.test(v))throw invalid('sourceCommit is invalid.');return v;}
function iso(input:unknown,label:string):string{const v=String(input??'');if(!v||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)throw invalid(label+' must be canonical ISO.');return v;}
function integer(input:unknown,min:number,max:number,label:string):number{const v=Number(input);if(!Number.isSafeInteger(v)||v<min||v>max)throw invalid(label+' is invalid.');return v;}
function sha256(v:string):string{return crypto.createHash('sha256').update(v,'utf8').digest('hex');}
function invalid(m:string):OperatorError{return new OperatorError('ENTERPRISE_FLEET_INVALID',m);}
