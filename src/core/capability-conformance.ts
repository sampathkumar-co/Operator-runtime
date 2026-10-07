import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import {
  capabilityManifestDigest,
  validateManifest,
  type CapabilityExtensionManifest
} from './capability-sdk.ts';
import { OperatorError } from './errors.ts';

export type CapabilityConformanceSuite =
  | 'SANDBOX'
  | 'CONTRACT'
  | 'ADVERSARIAL'
  | 'PERFORMANCE';

export interface CapabilityPerformanceMetrics {
  p95LatencyMs?: number;
  failureRate?: number;
  peakMemoryMb?: number;
}

export interface CapabilityConformanceReceipt {
  schemaVersion: 1;
  id: string;
  suite: CapabilityConformanceSuite;
  manifestDigest: string;
  verifierId: string;
  independent: boolean;
  passed: boolean;
  evidenceArtifactIds: string[];
  observedAt: string;
  metrics?: CapabilityPerformanceMetrics;
}

export interface CapabilityCertificationPolicy {
  requiredSuites: CapabilityConformanceSuite[];
  requireIndependentVerification: boolean;
  maxP95LatencyMs?: number;
  maxFailureRate?: number;
  maxPeakMemoryMb?: number;
}

export interface CapabilityCertification {
  schemaVersion: 1;
  id: string;
  manifestDigest: string;
  extensionId: string;
  extensionVersion: string;
  status: 'CERTIFIED' | 'REJECTED';
  reasons: string[];
  receiptIds: string[];
  policy: CapabilityCertificationPolicy;
  certifiedAt: string;
}

export interface CapabilityRevocationRecord {
  schemaVersion: 1;
  id: string;
  certificationId: string;
  manifestDigest: string;
  reasonCode: string;
  evidenceArtifactIds: string[];
  revokedAt: string;
}

export interface CapabilityAdmissionDecision {
  allowed: boolean;
  reason: 'CERTIFIED' | 'CERTIFICATION_REJECTED' | 'REVOKED';
  certificationId: string;
  revocationId?: string;
}

const ALL_SUITES: CapabilityConformanceSuite[] = [
  'SANDBOX',
  'CONTRACT',
  'ADVERSARIAL',
  'PERFORMANCE'
];

export function createCapabilityConformanceReceipt(input: {
  suite: CapabilityConformanceSuite;
  manifestDigest: string;
  verifierId: string;
  independent: boolean;
  passed: boolean;
  evidenceArtifactIds: string[];
  observedAt: string;
  metrics?: CapabilityPerformanceMetrics;
}): CapabilityConformanceReceipt {
  const normalized = normalizeReceiptFields(input);
  const identity = { schemaVersion: 1 as const, ...normalized };
  return {
    ...identity,
    id: sha256(canonicalJson(identity))
  };
}

export function validateCapabilityConformanceReceipt(input: CapabilityConformanceReceipt): CapabilityConformanceReceipt {
  if (!input || input.schemaVersion !== 1 || typeof input.id !== 'string') {
    throw invalid('Capability conformance receipt shape is invalid.');
  }
  const normalized = createCapabilityConformanceReceipt(input);
  if (normalized.id !== input.id) throw invalid('Capability conformance receipt id does not match its content.');
  return normalized;
}

export function certifyCapabilityExtension(input: {
  manifest: CapabilityExtensionManifest;
  receipts: CapabilityConformanceReceipt[];
  policy?: Partial<CapabilityCertificationPolicy>;
  certifiedAt?: string;
}): CapabilityCertification {
  const manifest = validateManifest(input.manifest);
  const manifestDigest = capabilityManifestDigest(manifest);
  const receipts = normalizeReceipts(input.receipts);
  const policy = normalizePolicy(input.policy ?? {});
  const certifiedAt = canonicalIso(input.certifiedAt ?? new Date().toISOString(), 'certifiedAt');
  const reasons: string[] = [];

  const bySuite = new Map<CapabilityConformanceSuite, CapabilityConformanceReceipt[]>();
  for (const receipt of receipts) {
    const bucket = bySuite.get(receipt.suite) ?? [];
    bucket.push(receipt);
    bySuite.set(receipt.suite, bucket);

    if (receipt.manifestDigest !== manifestDigest) {
      reasons.push(`${receipt.suite}:MANIFEST_DIGEST_MISMATCH`);
    }
    if (!receipt.passed) reasons.push(`${receipt.suite}:FAILED`);
    if (policy.requireIndependentVerification && !receipt.independent) {
      reasons.push(`${receipt.suite}:NOT_INDEPENDENT`);
    }
    if (receipt.evidenceArtifactIds.length === 0) {
      reasons.push(`${receipt.suite}:EVIDENCE_MISSING`);
    }
    if (Date.parse(receipt.observedAt) > Date.parse(certifiedAt)) {
      reasons.push(`${receipt.suite}:FUTURE_RECEIPT`);
    }
  }

  for (const suite of policy.requiredSuites) {
    const bucket = bySuite.get(suite) ?? [];
    if (bucket.length === 0) reasons.push(`${suite}:MISSING`);
    if (bucket.length > 1) reasons.push(`${suite}:DUPLICATE`);
  }

  const performance = bySuite.get('PERFORMANCE')?.[0];
  if (performance) {
    applyPerformancePolicy(performance.metrics ?? {}, policy, reasons);
  }

  const uniqueReasons = [...new Set(reasons)].sort();
  const identity = {
    schemaVersion: 1 as const,
    manifestDigest,
    extensionId: manifest.id,
    extensionVersion: manifest.version,
    status: uniqueReasons.length === 0 ? 'CERTIFIED' as const : 'REJECTED' as const,
    reasons: uniqueReasons,
    receiptIds: receipts.map((receipt) => receipt.id).sort(),
    policy,
    certifiedAt
  };
  return {
    ...identity,
    id: sha256(canonicalJson(identity))
  };
}

export function validateCapabilityCertification(input: CapabilityCertification): CapabilityCertification {
  if (!input || input.schemaVersion !== 1 || typeof input.id !== 'string') {
    throw invalid('Capability certification shape is invalid.');
  }
  const normalizedPolicy = normalizePolicy(input.policy);
  const normalized = {
    schemaVersion: 1 as const,
    manifestDigest: digest(input.manifestDigest, 'manifestDigest'),
    extensionId: boundedId(input.extensionId, 'extensionId'),
    extensionVersion: semver(input.extensionVersion),
    status: normalizeStatus(input.status),
    reasons: uniqueReasonCodes(input.reasons),
    receiptIds: uniqueDigests(input.receiptIds, 'receiptIds'),
    policy: normalizedPolicy,
    certifiedAt: canonicalIso(input.certifiedAt, 'certifiedAt')
  };
  const expected = sha256(canonicalJson(normalized));
  if (expected !== input.id) throw invalid('Capability certification id does not match its content.');
  return { ...normalized, id: expected };
}

export function createCapabilityRevocation(input: {
  certificationId: string;
  manifestDigest: string;
  reasonCode: string;
  evidenceArtifactIds: string[];
  revokedAt?: string;
}): CapabilityRevocationRecord {
  const normalized = {
    schemaVersion: 1 as const,
    certificationId: digest(input.certificationId, 'certificationId'),
    manifestDigest: digest(input.manifestDigest, 'manifestDigest'),
    reasonCode: boundedReason(input.reasonCode),
    evidenceArtifactIds: uniqueDigests(input.evidenceArtifactIds, 'evidenceArtifactIds'),
    revokedAt: canonicalIso(input.revokedAt ?? new Date().toISOString(), 'revokedAt')
  };
  if (normalized.evidenceArtifactIds.length === 0) {
    throw invalid('Capability revocation requires at least one evidence artifact.');
  }
  return { ...normalized, id: sha256(canonicalJson(normalized)) };
}

export function validateCapabilityRevocation(input: CapabilityRevocationRecord): CapabilityRevocationRecord {
  if (!input || input.schemaVersion !== 1 || typeof input.id !== 'string') {
    throw invalid('Capability revocation shape is invalid.');
  }
  const normalized = createCapabilityRevocation(input);
  if (normalized.id !== input.id) throw invalid('Capability revocation id does not match its content.');
  return normalized;
}

export function evaluateCapabilityAdmission(
  certificationInput: CapabilityCertification,
  revocationsInput: CapabilityRevocationRecord[]
): CapabilityAdmissionDecision {
  const certification = validateCapabilityCertification(certificationInput);
  if (certification.status !== 'CERTIFIED') {
    return {
      allowed: false,
      reason: 'CERTIFICATION_REJECTED',
      certificationId: certification.id
    };
  }
  if (!Array.isArray(revocationsInput) || revocationsInput.length > 100_000) {
    throw invalid('Capability revocation collection is invalid.');
  }
  const matching = revocationsInput
    .map(validateCapabilityRevocation)
    .filter((item) =>
      item.certificationId === certification.id ||
      item.manifestDigest === certification.manifestDigest
    )
    .sort((a, b) => a.revokedAt.localeCompare(b.revokedAt) || a.id.localeCompare(b.id))[0];

  if (matching) {
    return {
      allowed: false,
      reason: 'REVOKED',
      certificationId: certification.id,
      revocationId: matching.id
    };
  }
  return {
    allowed: true,
    reason: 'CERTIFIED',
    certificationId: certification.id
  };
}

function normalizeReceiptFields(input: {
  suite: CapabilityConformanceSuite;
  manifestDigest: string;
  verifierId: string;
  independent: boolean;
  passed: boolean;
  evidenceArtifactIds: string[];
  observedAt: string;
  metrics?: CapabilityPerformanceMetrics;
}) {
  const suite = normalizeSuite(input.suite);
  const manifestDigest = digest(input.manifestDigest, 'manifestDigest');
  const verifierId = boundedId(input.verifierId, 'verifierId');
  if (typeof input.independent !== 'boolean' || typeof input.passed !== 'boolean') {
    throw invalid('Capability conformance receipt booleans are invalid.');
  }
  const evidenceArtifactIds = uniqueDigests(input.evidenceArtifactIds, 'evidenceArtifactIds');
  const observedAt = canonicalIso(input.observedAt, 'observedAt');
  const metrics = input.metrics === undefined ? undefined : normalizeMetrics(input.metrics);
  if (suite !== 'PERFORMANCE' && metrics !== undefined) {
    throw invalid('Performance metrics may only appear on PERFORMANCE receipts.');
  }
  return {
    suite,
    manifestDigest,
    verifierId,
    independent: input.independent,
    passed: input.passed,
    evidenceArtifactIds,
    observedAt,
    ...(metrics ? { metrics } : {})
  };
}

function normalizeReceipts(input: CapabilityConformanceReceipt[]): CapabilityConformanceReceipt[] {
  if (!Array.isArray(input) || input.length > 100) throw invalid('Capability conformance receipt collection is invalid.');
  const receipts = input.map(validateCapabilityConformanceReceipt);
  if (new Set(receipts.map((receipt) => receipt.id)).size !== receipts.length) {
    throw invalid('Capability conformance receipts contain duplicate ids.');
  }
  return receipts.sort((a, b) => a.suite.localeCompare(b.suite) || a.id.localeCompare(b.id));
}

function normalizePolicy(input: Partial<CapabilityCertificationPolicy>): CapabilityCertificationPolicy {
  const requiredInput = input.requiredSuites ?? ALL_SUITES;
  if (!Array.isArray(requiredInput) || requiredInput.length < 1 || requiredInput.length > ALL_SUITES.length) {
    throw invalid('Capability certification requiredSuites is invalid.');
  }
  const requiredSuites = [...new Set(requiredInput.map(normalizeSuite))].sort() as CapabilityConformanceSuite[];
  if (typeof (input.requireIndependentVerification ?? true) !== 'boolean') {
    throw invalid('Capability certification independence policy is invalid.');
  }
  return {
    requiredSuites,
    requireIndependentVerification: input.requireIndependentVerification ?? true,
    ...(input.maxP95LatencyMs !== undefined
      ? { maxP95LatencyMs: finite(input.maxP95LatencyMs, 0, 24 * 60 * 60_000, 'maxP95LatencyMs') }
      : {}),
    ...(input.maxFailureRate !== undefined
      ? { maxFailureRate: finite(input.maxFailureRate, 0, 1, 'maxFailureRate') }
      : {}),
    ...(input.maxPeakMemoryMb !== undefined
      ? { maxPeakMemoryMb: finite(input.maxPeakMemoryMb, 1, 1024 * 1024, 'maxPeakMemoryMb') }
      : {})
  };
}

function normalizeMetrics(input: CapabilityPerformanceMetrics): CapabilityPerformanceMetrics {
  if (!input || typeof input !== 'object') throw invalid('Capability performance metrics are invalid.');
  return {
    ...(input.p95LatencyMs !== undefined
      ? { p95LatencyMs: finite(input.p95LatencyMs, 0, 24 * 60 * 60_000, 'p95LatencyMs') }
      : {}),
    ...(input.failureRate !== undefined
      ? { failureRate: finite(input.failureRate, 0, 1, 'failureRate') }
      : {}),
    ...(input.peakMemoryMb !== undefined
      ? { peakMemoryMb: finite(input.peakMemoryMb, 0, 1024 * 1024, 'peakMemoryMb') }
      : {})
  };
}

function applyPerformancePolicy(
  metrics: CapabilityPerformanceMetrics,
  policy: CapabilityCertificationPolicy,
  reasons: string[]
): void {
  if (policy.maxP95LatencyMs !== undefined) {
    if (metrics.p95LatencyMs === undefined) reasons.push('PERFORMANCE:P95_MISSING');
    else if (metrics.p95LatencyMs > policy.maxP95LatencyMs) reasons.push('PERFORMANCE:P95_EXCEEDED');
  }
  if (policy.maxFailureRate !== undefined) {
    if (metrics.failureRate === undefined) reasons.push('PERFORMANCE:FAILURE_RATE_MISSING');
    else if (metrics.failureRate > policy.maxFailureRate) reasons.push('PERFORMANCE:FAILURE_RATE_EXCEEDED');
  }
  if (policy.maxPeakMemoryMb !== undefined) {
    if (metrics.peakMemoryMb === undefined) reasons.push('PERFORMANCE:MEMORY_MISSING');
    else if (metrics.peakMemoryMb > policy.maxPeakMemoryMb) reasons.push('PERFORMANCE:MEMORY_EXCEEDED');
  }
}

function normalizeSuite(input: unknown): CapabilityConformanceSuite {
  if (!ALL_SUITES.includes(input as CapabilityConformanceSuite)) {
    throw invalid('Capability conformance suite is invalid.');
  }
  return input as CapabilityConformanceSuite;
}

function normalizeStatus(input: unknown): CapabilityCertification['status'] {
  if (input !== 'CERTIFIED' && input !== 'REJECTED') throw invalid('Capability certification status is invalid.');
  return input;
}

function uniqueDigests(input: unknown, label: string): string[] {
  if (!Array.isArray(input) || input.length > 10_000) throw invalid(`${label} is invalid.`);
  return [...new Set(input.map((item) => digest(item, label)))].sort();
}

function uniqueReasonCodes(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 1000) throw invalid('Capability certification reasons are invalid.');
  const values = input.map((item) => {
    const value = String(item ?? '');
    if (!/^[A-Z0-9_:-]{1,256}$/.test(value)) throw invalid('Capability certification reason is invalid.');
    return value;
  });
  return [...new Set(values)].sort();
}

function boundedReason(input: unknown): string {
  const value = String(input ?? '');
  if (!/^[A-Z0-9_:-]{1,256}$/.test(value)) throw invalid('Capability revocation reasonCode is invalid.');
  return value;
}

function boundedId(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!/^[A-Za-z0-9._:@/+\-=]{1,256}$/.test(value)) throw invalid(`${label} is invalid.`);
  return value;
}

function semver(input: unknown): string {
  const value = String(input ?? '');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) {
    throw invalid('Capability certification extensionVersion must be SemVer.');
  }
  return value;
}

function digest(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw invalid(`${label} must be SHA-256.`);
  return value;
}

function canonicalIso(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!value || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw invalid(`${label} must be canonical ISO.`);
  }
  return value;
}

function finite(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value < min || value > max) throw invalid(`${label} is invalid.`);
  return value;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function invalid(message: string): OperatorError {
  return new OperatorError('CAPABILITY_CERTIFICATION_INVALID', message);
}
