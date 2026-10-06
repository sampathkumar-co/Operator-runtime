import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  assessBoundPolicyPromotion,
  validatePolicyPromotionEvidenceBundle,
  type PolicyPromotionEvidenceBundle
} from '../packages/adaptive-intelligence/src/promotion-evidence.ts';
import type { PolicyPromotionCriteria } from '../packages/adaptive-intelligence/src/policy-promotion-gate.ts';
import {
  assertPromotionEligible,
  type AdaptivePlanningPromotionEvidence
} from '../src/core/adaptive-planning-control.ts';

const dir = path.resolve('artifacts', 'r2-empirical');
const certification = JSON.parse(await fs.readFile(path.join(dir, 'certification.json'), 'utf8')) as any;
const bundle = JSON.parse(await fs.readFile(path.join(dir, 'promotion-bundle.json'), 'utf8')) as PolicyPromotionEvidenceBundle;
const evidence = JSON.parse(await fs.readFile(path.join(dir, 'general-promotion-evidence.json'), 'utf8')) as AdaptivePlanningPromotionEvidence;
const promotionState = JSON.parse(await fs.readFile(path.join(dir, 'promotion-state.json'), 'utf8')) as any;
const criteria = certification.criteria as PolicyPromotionCriteria;
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().toLowerCase();

assert(certification?.schemaVersion === 1, 'certification schema');
assert(certification?.kind === 'r2-empirical-certification', 'certification kind');
assert(certification?.status === 'CERTIFIED', 'certification status');
assert(certification?.certificationSubject === head, 'certification subject must equal exact workflow head');
assert(certification?.historicalWindowEnd === 'ed5948ff3f386f91ccd27674ed278a8ba5c624e6', 'historical window boundary');
assert(certification?.taskCount >= 1_000, 'representative task count');
assert(certification?.pairedDecisions >= 10_000, 'representative shadow decision count');
assert(certification?.benchmarkExcluded === true, 'benchmark exclusion');
assert(certification?.paidExternalServicesUsed === false, 'zero-cost external-service policy');
assert(certification?.modelProvider === 'none', 'no paid model provider');
assert(certification?.authorityExpansionCount === 0, 'zero authority expansion');
assert(certification?.unsafeReplayCount === 0, 'zero unsafe replay');
assert(certification?.deterministicRestartVerified === true, 'deterministic restart');
assert(certification?.rollbackVerified === true, 'rollback proof');
assert(certification?.promotionMode === 'GENERAL', 'GENERAL eligibility state');
assert(certification?.statistics?.statisticallyDefensible === true, 'task-level statistical defensibility');
assert(certification?.statistics?.candidateOnlyWins >= 30, 'minimum paired task wins');
assert(certification?.statistics?.candidateOnlyWins > certification?.statistics?.controlOnlyWins, 'candidate paired wins exceed losses');
assert(certification?.statistics?.successRateDelta > 0, 'positive independently verified task outcome delta');
assert(certification?.statistics?.oneSidedExactSignTestP < 0.01, 'paired exact sign-test threshold');

const validated = validatePolicyPromotionEvidenceBundle(bundle);
const assessment = assessBoundPolicyPromotion(bundle, criteria);
assert(assessment.eligible, 'bound policy promotion assessment');
assert(validated.lineageDigest === certification.evaluationLineageDigest, 'evaluation lineage digest binding');
assert(assessment.criteriaDigest === certification.criteriaDigest, 'criteria digest binding');
assert(bundle.candidateManifest.benchmarkId === undefined && bundle.candidateManifest.benchmarkDigest === undefined, 'candidate manifest is non-benchmark');
assert(bundle.baselineManifest.benchmarkId === undefined && bundle.baselineManifest.benchmarkDigest === undefined, 'baseline manifest is non-benchmark');
assert(bundle.taskCohort.taskCount >= 1_000, 'frozen cohort task count');
assert(bundle.shadow.report.pairedDecisions >= 10_000, 'bound shadow decision count');
assert(bundle.shadow.report.outcomeCoverage >= 0.9, 'outcome coverage');
assert(bundle.shadow.report.progressCoverage >= 0.8, 'progress coverage');
assert(bundle.shadow.report.costCoverage >= 0.8, 'cost coverage');
assert(bundle.shadow.report.shadowWinRate > bundle.shadow.report.controlWinRate, 'verified shadow outcome improvement');

assertPromotionEligible('GENERAL', evidence);
assert(evidence.representativeShadowDecisions >= 10_000, 'core promotion shadow count');
assert(evidence.representativeTaskCount >= 1_000, 'core promotion task count');
assert(evidence.benchmarkExcluded === true, 'core promotion benchmark exclusion');
assert(evidence.verifiedOutcomeDelta > 0, 'core promotion verified-outcome improvement');
assert(evidence.authorityExpansionCount === 0, 'core promotion zero authority expansion');
assert(evidence.unsafeReplayCount === 0, 'core promotion zero unsafe replay');
assert(evidence.deterministicRestartVerified === true, 'core promotion deterministic restart');
assert(evidence.verificationReceiptDigests.length >= 1_000, 'independent verification receipt coverage');
assert(promotionState?.promotedState?.mode === 'GENERAL', 'promoted state mode');
assert(promotionState?.rollbackVerified === true, 'promoted state rollback verification');

const sumsText = await fs.readFile(path.join(dir, 'sha256sums.txt'), 'utf8');
for (const line of sumsText.split(/\r?\n/).filter(Boolean)) {
  const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
  assert(Boolean(match), 'sha256sums format');
  const actual = crypto.createHash('sha256').update(await fs.readFile(path.join(dir, match![2]!))).digest('hex');
  assert(actual === match![1], 'artifact digest mismatch: ' + match![2]);
}

console.log(JSON.stringify({
  status: 'PASS',
  certificationSubject: head,
  taskCount: certification.taskCount,
  pairedDecisions: certification.pairedDecisions,
  candidateSuccessRate: certification.statistics.candidateSuccessRate,
  controlSuccessRate: certification.statistics.controlSuccessRate,
  successRateDelta: certification.statistics.successRateDelta,
  exactP: certification.statistics.oneSidedExactSignTestP,
  verifiedOutcomeDelta: evidence.verifiedOutcomeDelta,
  authorityExpansionCount: evidence.authorityExpansionCount,
  unsafeReplayCount: evidence.unsafeReplayCount,
  promotionMode: promotionState.promotedState.mode,
  rollbackVerified: promotionState.rollbackVerified
}, null, 2));

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error('R2 empirical certification verification failed: ' + label);
}
