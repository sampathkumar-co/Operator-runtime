import {
  assessBoundPolicyPromotion,
  validatePolicyPromotionEvidenceBundle,
  type PolicyPromotionCriteria,
  type PolicyPromotionEvidenceBundle
} from '../packages/adaptive-intelligence/src/index.ts';
import type { AdaptivePlanningPromotionEvidence } from '../src/core/adaptive-planning-control.ts';

export interface R2GeneralOperationalEvidence {
  evaluationLineageDigest: string;
  authorityExpansionCount: number;
  unsafeReplayCount: number;
  deterministicRestartVerified: boolean;
  rollbackSnapshotDigest: string;
  verificationReceiptDigests: string[];
  evaluatedAt: string;
}

export interface R2GeneralPromotionEvidenceInput {
  bundle: PolicyPromotionEvidenceBundle;
  criteria: PolicyPromotionCriteria;
  operational: R2GeneralOperationalEvidence;
}

export function deriveR2GeneralPromotionEvidence(
  input: R2GeneralPromotionEvidenceInput
): AdaptivePlanningPromotionEvidence {
  if (!input || typeof input !== 'object') throw new Error('R2 general promotion input is required.');
  const bundle = validatePolicyPromotionEvidenceBundle(input.bundle);
  const assessment = assessBoundPolicyPromotion(input.bundle, input.criteria);
  if (!assessment.eligible) {
    throw new Error('R2 general promotion evidence failed the bound policy assessment: ' + assessment.reasons.join('; '));
  }

  assertGeneralCriteria(input.criteria);
  if (bundle.candidateManifest.benchmarkId !== undefined ||
      bundle.candidateManifest.benchmarkDigest !== undefined ||
      bundle.baselineManifest.benchmarkId !== undefined ||
      bundle.baselineManifest.benchmarkDigest !== undefined) {
    throw new Error('R2 general promotion requires a representative non-benchmark evaluation cohort.');
  }

  const operational = normalizeOperational(input.operational);
  if (operational.evaluationLineageDigest !== bundle.lineageDigest) {
    throw new Error('Operational promotion evidence is not bound to the validated evaluation lineage.');
  }

  const shadow = bundle.shadow.report;
  const candidate = bundle.candidateMetrics.value;
  const baseline = bundle.baselineMetrics.value;

  return {
    representativeShadowDecisions: shadow.pairedDecisions,
    representativeTaskCount: bundle.taskCohort.taskCount,
    benchmarkExcluded: true,
    verifiedOutcomeDelta: round(shadow.shadowWinRate - shadow.controlWinRate),
    falseCompletionDelta: round(candidate.falseGoalProgressRate - baseline.falseGoalProgressRate),
    repeatedFailureDelta: round(candidate.repeatedEquivalentFailureRate - baseline.repeatedEquivalentFailureRate),
    recoverySuccessDelta: round(candidate.recoverySuccessRate - baseline.recoverySuccessRate),
    authorityExpansionCount: operational.authorityExpansionCount,
    unsafeReplayCount: operational.unsafeReplayCount,
    statisticallyDefensible: true,
    deterministicRestartVerified: operational.deterministicRestartVerified,
    rollbackSnapshotDigest: operational.rollbackSnapshotDigest,
    verificationReceiptDigests: operational.verificationReceiptDigests,
    evaluatedAt: operational.evaluatedAt,
    evaluationLineageDigest: bundle.lineageDigest,
    candidateManifestDigest: assessment.candidateManifestDigest,
    baselineManifestDigest: assessment.baselineManifestDigest,
    criteriaDigest: assessment.criteriaDigest
  };
}

function assertGeneralCriteria(criteria: PolicyPromotionCriteria): void {
  if (criteria.minPairedDecisions < 10_000) throw new Error('R2 GENERAL criteria must require at least 10,000 paired decisions.');
  if (criteria.minCandidateTasks < 1_000 || criteria.minBaselineTasks < 1_000) {
    throw new Error('R2 GENERAL criteria must require at least 1,000 candidate and baseline tasks.');
  }
  if (criteria.minCalibrationSamples < 1_000) {
    throw new Error('R2 GENERAL criteria must require at least 1,000 calibration samples.');
  }
  if (criteria.minOutcomeCoverage < 0.9 || criteria.minProgressCoverage < 0.8 || criteria.minCostCoverage < 0.8) {
    throw new Error('R2 GENERAL criteria weaken minimum evidence coverage.');
  }
}

function normalizeOperational(input: R2GeneralOperationalEvidence): R2GeneralOperationalEvidence {
  if (!input || typeof input !== 'object') throw new Error('R2 operational evidence is required.');
  return {
    evaluationLineageDigest: sha256(input.evaluationLineageDigest, 'evaluationLineageDigest'),
    authorityExpansionCount: integer(input.authorityExpansionCount, 'authorityExpansionCount'),
    unsafeReplayCount: integer(input.unsafeReplayCount, 'unsafeReplayCount'),
    deterministicRestartVerified: input.deterministicRestartVerified === true,
    rollbackSnapshotDigest: sha256(input.rollbackSnapshotDigest, 'rollbackSnapshotDigest'),
    verificationReceiptDigests: uniqueDigests(input.verificationReceiptDigests),
    evaluatedAt: iso(input.evaluatedAt, 'evaluatedAt')
  };
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) throw new Error(label + ' must be SHA-256.');
  return value.toLowerCase();
}
function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new Error(label + ' is invalid.');
  }
  return value;
}
function uniqueDigests(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100_000) {
    throw new Error('verificationReceiptDigests is invalid.');
  }
  return [...new Set(value.map((item) => sha256(item, 'verificationReceiptDigest')))].sort();
}
function iso(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(label + ' must be canonical ISO.');
  }
  return value;
}
function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
