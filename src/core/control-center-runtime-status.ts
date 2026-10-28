import { OperatorError } from './errors.ts';

export type RuntimeFreshness = 'FRESH' | 'AGING' | 'STALE' | 'UNKNOWN' | 'NOT_APPLICABLE';
export type VersionCompatibility = 'MATCH' | 'MISMATCH' | 'UNKNOWN';

export interface ControlCenterRuntimeStatus {
  schemaVersion: 1;
  observedAt: string;
  uptimeMs: number;
  product: {
    runtimeVersion: string;
    packageVersion?: string;
    compatibility: VersionCompatibility;
    sourceCommit?: string;
    sourceIdentity: 'KNOWN' | 'UNKNOWN';
  };
  relay: {
    state: string;
    configured: boolean;
    required: boolean;
    continuity: 'automatic' | 'disabled' | 'unknown';
    updatedAt?: string;
    ageMs?: number;
    freshness: RuntimeFreshness;
    sourceCommit?: string;
    sourceCompatibility: VersionCompatibility;
    code?: string;
  };
  capabilities: { count: number; names: string[] };
  configuration: {
    authorizedRootCount: number;
    optionalFeatures: Array<{ name: string; configured: boolean }>;
  };
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const CODE = /^[A-Z0-9_:-]{1,128}$/;
const CAPABILITY = /^[a-z][a-z0-9]*(?:[._-][a-z0-9*]+)*$/;
const MAX_CAPABILITIES = 512;
const FRESH_MS = 60_000;
const STALE_MS = 5 * 60_000;

export function buildControlCenterRuntimeStatus(input: {
  productVersion: unknown;
  startedAt: unknown;
  observedAt?: unknown;
  runtimeStatus?: unknown;
  supportedCapabilities?: unknown;
  authorizedRootCount?: unknown;
  settings?: unknown;
}): ControlCenterRuntimeStatus {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Runtime status input is invalid.');
  const observedAt = canonicalIso(input.observedAt ?? new Date().toISOString(), 'observedAt');
  const startedAt = canonicalIso(input.startedAt, 'startedAt');
  const observedMs = Date.parse(observedAt);
  const startedMs = Date.parse(startedAt);
  if (startedMs > observedMs) throw invalid('Runtime start cannot be after the observation.');
  const uptimeMs = observedMs - startedMs;
  if (!Number.isSafeInteger(uptimeMs)) throw invalid('Runtime uptime is invalid.');

  const runtimeVersion = semver(input.productVersion, 'productVersion');
  const rawRuntime = record(input.runtimeStatus);
  const packageVersion = optionalSemver(rawRuntime.packageVersion);
  const sourceCommit = optionalCommit(rawRuntime.sourceCommit);
  const relay = relayProjection(rawRuntime.relay, observedMs, sourceCommit);
  const names = capabilityNames(input.supportedCapabilities);
  const authorizedRootCount = safeCount(input.authorizedRootCount, 'authorizedRootCount');
  const optionalFeatures = featureProjection(input.settings);

  return {
    schemaVersion: 1,
    observedAt,
    uptimeMs,
    product: {
      runtimeVersion,
      ...(packageVersion ? { packageVersion } : {}),
      compatibility: packageVersion ? (packageVersion === runtimeVersion ? 'MATCH' : 'MISMATCH') : 'UNKNOWN',
      ...(sourceCommit ? { sourceCommit } : {}),
      sourceIdentity: sourceCommit ? 'KNOWN' : 'UNKNOWN'
    },
    relay,
    capabilities: { count: names.length, names },
    configuration: { authorizedRootCount, optionalFeatures }
  };
}

function relayProjection(input: unknown, observedMs: number, localSourceCommit?: string): ControlCenterRuntimeStatus['relay'] {
  const raw = record(input);
  const configured = raw.configured === true;
  const required = raw.required === true;
  const state = typeof raw.state === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(raw.state)
    ? raw.state : configured ? 'UNKNOWN' : 'DISABLED';
  const continuity = raw.continuity === 'automatic' || raw.continuity === 'disabled'
    ? raw.continuity : 'unknown';
  // A relay heartbeat from the future is not evidence of present freshness.
  // Do not clamp a skewed/forged timestamp to zero age and report FRESH.
  const candidateUpdatedAt = optionalIso(raw.updatedAt);
  const updatedAt = candidateUpdatedAt && Date.parse(candidateUpdatedAt) <= observedMs
    ? candidateUpdatedAt : undefined;
  const ageMs = updatedAt ? observedMs - Date.parse(updatedAt) : undefined;
  const freshness: RuntimeFreshness = !configured || state === 'DISABLED'
    ? 'NOT_APPLICABLE'
    : ageMs === undefined ? 'UNKNOWN'
      : ageMs <= FRESH_MS ? 'FRESH'
        : ageMs <= STALE_MS ? 'AGING' : 'STALE';
  const code = typeof raw.code === 'string' && CODE.test(raw.code) ? raw.code : undefined;
  const relayCommit = optionalCommit(raw.sourceCommit);
  // Never assert source parity from an absent, stale, or disconnected relay.
  const sourceCompatibility: VersionCompatibility =
    !relayCommit || !localSourceCommit || freshness === 'STALE' ||
    freshness === 'UNKNOWN' || state !== 'READY'
      ? 'UNKNOWN' : relayCommit === localSourceCommit ? 'MATCH' : 'MISMATCH';
  return {
    state,
    configured,
    required,
    continuity,
    ...(updatedAt ? { updatedAt, ageMs } : {}),
    freshness,
    ...(relayCommit ? { sourceCommit: relayCommit } : {}),
    sourceCompatibility,
    ...(code ? { code } : {})
  };
}

function capabilityNames(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > MAX_CAPABILITIES) throw invalid('Supported capabilities are invalid.');
  const names = input.map((value) => {
    if (typeof value !== 'string' || !CAPABILITY.test(value) || value.length > 128) throw invalid('Supported capability name is invalid.');
    return value;
  });
  if (new Set(names).size !== names.length) throw invalid('Supported capabilities contain duplicates.');
  return names.sort();
}

function featureProjection(input: unknown): Array<{ name: string; configured: boolean }> {
  const raw = record(input);
  return Object.entries(raw)
    .filter(([name, value]) => /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) && typeof value === 'boolean')
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 64)
    .map(([name, configured]) => ({ name, configured: configured as boolean }));
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function semver(input: unknown, label: string): string {
  if (typeof input !== 'string' || !SEMVER.test(input) || input.length > 64) throw invalid(`${label} is invalid.`);
  return input;
}

function optionalSemver(input: unknown): string | undefined {
  return typeof input === 'string' && SEMVER.test(input) && input.length <= 64 ? input : undefined;
}

function optionalCommit(input: unknown): string | undefined {
  return typeof input === 'string' && COMMIT.test(input.toLowerCase()) ? input.toLowerCase() : undefined;
}

function optionalIso(input: unknown): string | undefined {
  if (typeof input !== 'string' || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) return undefined;
  return input;
}

function canonicalIso(input: unknown, label: string): string {
  const value = optionalIso(input);
  if (!value) throw invalid(`${label} must be canonical ISO.`);
  return value;
}

function safeCount(input: unknown, label: string): number {
  if (!Number.isSafeInteger(input) || Number(input) < 0 || Number(input) > 1_000_000) throw invalid(`${label} is invalid.`);
  return Number(input);
}

function invalid(message: string): OperatorError {
  return new OperatorError('CONTROL_CENTER_RUNTIME_STATUS_INVALID', message);
}
