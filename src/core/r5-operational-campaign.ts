import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';
import {
  evaluateProductionPlatformSlo,
  type ProductionPlatformSloObservation,
  type ProductionPlatformSloPolicy
} from './production-trust-platform.ts';

export type R5FaultClass =
  | 'kill-at-transition'
  | 'network-partition-reorder-duplication'
  | 'reboot-sleep-clock-drift'
  | 'disk-full'
  | 'permission-failure'
  | 'corruption'
  | 'large-event-growth'
  | 'backup-during-mutation'
  | 'verified-restore'
  | 'split-brain-worker'
  | 'staged-update-rollback';

export interface R5FaultEvidence {
  fault: R5FaultClass;
  exercised: boolean;
  passed: boolean;
  evidenceDigests: string[];
}

export interface R5OperationalCampaignBody {
  schemaVersion: 1;
  campaignId: string;
  sourceSha: string;
  environmentDigest: string;
  productionLikeEnvironment: boolean;
  controlPlaneBackend: 'postgresql';
  relayInstanceCount: number;
  sharedDurableState: boolean;
  startedAt: string;
  endedAt: string;
  traceCoverageRate: number;
  multiInstanceStateSafe: boolean;
  restoreCoherent: boolean;
  stagedUpdateRollbackProven: boolean;
  metrics: ProductionPlatformSloObservation;
  policy: ProductionPlatformSloPolicy;
  faults: R5FaultEvidence[];
  externalEvidenceDigests: string[];
}

export interface R5OperationalCampaign {
  body: R5OperationalCampaignBody;
  digest: string;
}

export interface R5OperationalCertificationReport {
  schemaVersion: 1;
  sourceSha: string;
  campaignId: string;
  durationMs: number;
  soak24hPassed: boolean;
  soak72hPassed: boolean;
  sloHealthy: boolean;
  traceCoverageRate: number;
  allFaultClassesPassed: boolean;
  status: 'CERTIFIED' | 'NOT_CERTIFIED';
  reasons: string[];
  campaignDigest: string;
  reportDigest: string;
}

const REQUIRED_FAULTS: R5FaultClass[] = [
  'kill-at-transition',
  'network-partition-reorder-duplication',
  'reboot-sleep-clock-drift',
  'disk-full',
  'permission-failure',
  'corruption',
  'large-event-growth',
  'backup-during-mutation',
  'verified-restore',
  'split-brain-worker',
  'staged-update-rollback'
];

export const MINIMUM_R5_CERTIFICATION_POLICY: ProductionPlatformSloPolicy = Object.freeze({
  minVerificationRate: 0.99,
  maxFalseCompletionRate: 0,
  maxUncertainRate: 0.01,
  maxP95CompletionMs: 20_000,
  minCrashFreeSessionRate: 0.999,
  minUpdateSuccessRate: 0.99,
  minControlPlaneAvailability: 0.999,
  minReconnectSuccessRate: 0.99,
  maxP95DispatchMs: 2_000,
  maxP95VerificationMs: 5_000,
  maxQueueDepth: 1_000,
  maxP95DeliveryAgeMs: 5_000,
  maxP95ReconciliationMs: 30_000,
  maxStateBytes: 10 * 1024 * 1024 * 1024,
  maxRetentionViolationCount: 0
});

export function createR5OperationalCampaign(input: R5OperationalCampaignBody): R5OperationalCampaign {
  const body = normalizeBody(input);
  return { body, digest: hash(body) };
}

export function verifyR5OperationalCampaign(input: R5OperationalCampaign): boolean {
  try {
    const body = normalizeBody(input.body);
    return digest(input.digest, 'campaign digest') === hash(body);
  } catch {
    return false;
  }
}

export function certifyR5OperationalCampaign(input: R5OperationalCampaign): R5OperationalCertificationReport {
  if (!verifyR5OperationalCampaign(input)) throw invalid('Operational campaign digest verification failed.');
  const body = normalizeBody(input.body);
  const durationMs = Date.parse(body.endedAt) - Date.parse(body.startedAt);
  const reasons: string[] = [];
  const soak24hPassed = durationMs >= 24 * 60 * 60_000;
  const soak72hPassed = durationMs >= 72 * 60 * 60_000;

  if (!body.productionLikeEnvironment) reasons.push('campaign was not run in a production-like environment');
  if (body.controlPlaneBackend !== 'postgresql') reasons.push('shared production control plane was not PostgreSQL');
  if (body.relayInstanceCount < 2) reasons.push('fewer than two relay instances participated');
  if (!body.sharedDurableState) reasons.push('relay instances did not share durable production state');
  if (!soak24hPassed) reasons.push('24-hour soak threshold was not reached');
  if (!soak72hPassed) reasons.push('72-hour soak threshold was not reached');
  if (body.traceCoverageRate < 1) reasons.push('user-visible operation trace coverage was below 100%');
  if (!body.multiInstanceStateSafe) reasons.push('multi-instance state safety was not proven');
  if (!body.restoreCoherent) reasons.push('coherent restore was not proven');
  if (!body.stagedUpdateRollbackProven) reasons.push('staged update halt/rollback was not proven');
  if (body.externalEvidenceDigests.length < 3) reasons.push('insufficient independent operational evidence artifacts');

  const faultMap = new Map(body.faults.map((fault) => [fault.fault, fault]));
  let allFaultClassesPassed = true;
  for (const fault of REQUIRED_FAULTS) {
    const evidence = faultMap.get(fault);
    if (!evidence || !evidence.exercised || !evidence.passed || evidence.evidenceDigests.length < 1) {
      allFaultClassesPassed = false;
      reasons.push('fault campaign incomplete: ' + fault);
    }
  }

  assertPolicyAtLeastMinimum(body.policy);
  const slo = evaluateProductionPlatformSlo(body.metrics, body.policy);
  if (!slo.healthy) reasons.push(...slo.reasons.map((reason) => 'SLO:' + reason));

  const base = {
    schemaVersion: 1 as const,
    sourceSha: body.sourceSha,
    campaignId: body.campaignId,
    durationMs,
    soak24hPassed,
    soak72hPassed,
    sloHealthy: slo.healthy,
    traceCoverageRate: body.traceCoverageRate,
    allFaultClassesPassed,
    status: reasons.length === 0 ? 'CERTIFIED' as const : 'NOT_CERTIFIED' as const,
    reasons,
    campaignDigest: input.digest
  };
  return { ...base, reportDigest: hash(base) };
}

function normalizeBody(input: R5OperationalCampaignBody): R5OperationalCampaignBody {
  if (!input || input.schemaVersion !== 1) throw invalid('Operational campaign schemaVersion must be 1.');
  const startedAt = iso(input.startedAt, 'startedAt');
  const endedAt = iso(input.endedAt, 'endedAt');
  if (Date.parse(endedAt) <= Date.parse(startedAt)) throw invalid('Campaign end must be after campaign start.');
  const faults = normalizeFaults(input.faults);
  return {
    schemaVersion: 1,
    campaignId: id(input.campaignId, 'campaignId'),
    sourceSha: gitSha(input.sourceSha, 'sourceSha'),
    environmentDigest: digest(input.environmentDigest, 'environmentDigest'),
    productionLikeEnvironment: bool(input.productionLikeEnvironment, 'productionLikeEnvironment'),
    controlPlaneBackend: input.controlPlaneBackend === 'postgresql' ? 'postgresql' : fail('controlPlaneBackend must be postgresql'),
    relayInstanceCount: integer(input.relayInstanceCount, 1, 10_000, 'relayInstanceCount'),
    sharedDurableState: bool(input.sharedDurableState, 'sharedDurableState'),
    startedAt,
    endedAt,
    traceCoverageRate: probability(input.traceCoverageRate, 'traceCoverageRate'),
    multiInstanceStateSafe: bool(input.multiInstanceStateSafe, 'multiInstanceStateSafe'),
    restoreCoherent: bool(input.restoreCoherent, 'restoreCoherent'),
    stagedUpdateRollbackProven: bool(input.stagedUpdateRollbackProven, 'stagedUpdateRollbackProven'),
    metrics: input.metrics,
    policy: input.policy,
    faults,
    externalEvidenceDigests: digestList(input.externalEvidenceDigests, 10_000, 'externalEvidenceDigests')
  };
}

function normalizeFaults(input: R5FaultEvidence[]): R5FaultEvidence[] {
  if (!Array.isArray(input) || input.length > 100) throw invalid('Fault evidence is invalid.');
  const seen = new Set<R5FaultClass>();
  return input.map((item) => {
    if (!REQUIRED_FAULTS.includes(item.fault)) throw invalid('Unknown fault class.');
    if (seen.has(item.fault)) throw invalid('Fault classes must be unique.');
    seen.add(item.fault);
    return {
      fault: item.fault,
      exercised: bool(item.exercised, 'fault.exercised'),
      passed: bool(item.passed, 'fault.passed'),
      evidenceDigests: digestList(item.evidenceDigests, 1000, 'fault.evidenceDigests')
    };
  });
}

function assertPolicyAtLeastMinimum(policy: ProductionPlatformSloPolicy): void {
  const minimum = MINIMUM_R5_CERTIFICATION_POLICY;
  const minFields: Array<keyof ProductionPlatformSloPolicy> = [
    'minVerificationRate','minCrashFreeSessionRate','minUpdateSuccessRate','minControlPlaneAvailability','minReconnectSuccessRate'
  ];
  for (const field of minFields) if (Number(policy[field]) < Number(minimum[field])) throw invalid('Campaign SLO policy is weaker than certification minimum: ' + field);
  const maxFields: Array<keyof ProductionPlatformSloPolicy> = [
    'maxFalseCompletionRate','maxUncertainRate','maxP95CompletionMs','maxP95DispatchMs','maxP95VerificationMs',
    'maxQueueDepth','maxP95DeliveryAgeMs','maxP95ReconciliationMs','maxStateBytes','maxRetentionViolationCount'
  ];
  for (const field of maxFields) if (Number(policy[field]) > Number(minimum[field])) throw invalid('Campaign SLO policy is weaker than certification minimum: ' + field);
}

function bool(value: unknown, label: string): boolean { if (typeof value !== 'boolean') throw invalid(label + ' is invalid.'); return value; }
function integer(value: unknown, min: number, max: number, label: string): number { const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) throw invalid(label + ' is invalid.'); return n; }
function probability(value: unknown, label: string): number { const n = Number(value); if (!Number.isFinite(n) || n < 0 || n > 1) throw invalid(label + ' is invalid.'); return n; }
function id(value: unknown, label: string): string { const s = String(value ?? ''); if (!/^[A-Za-z0-9._:@/+-]{1,512}$/.test(s)) throw invalid(label + ' is invalid.'); return s; }
function gitSha(value: unknown, label: string): string { const s = String(value ?? '').toLowerCase(); if (!/^[0-9a-f]{40}$/.test(s)) throw invalid(label + ' must be git SHA.'); return s; }
function digest(value: unknown, label: string): string { const s = String(value ?? '').toLowerCase(); if (!/^[0-9a-f]{64}$/.test(s)) throw invalid(label + ' must be SHA-256.'); return s; }
function digestList(value: unknown, max: number, label: string): string[] { if (!Array.isArray(value) || value.length > max) throw invalid(label + ' is invalid.'); return [...new Set(value.map((item) => digest(item, label)))].sort(); }
function iso(value: unknown, label: string): string { const s = String(value ?? ''); if (!Number.isFinite(Date.parse(s)) || new Date(s).toISOString() !== s) throw invalid(label + ' must be canonical ISO.'); return s; }
function hash(value: unknown): string { return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex'); }
function fail(message: string): never { throw invalid(message); }
function invalid(message: string): OperatorError { return new OperatorError('R5_OPERATIONAL_CAMPAIGN_INVALID', message); }
