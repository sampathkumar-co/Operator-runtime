import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import type { AutonomousObjectiveCertification } from './autonomous-objective-certification.ts';
import type { CounterfactualSelection, CounterfactualTwinReceipt } from './counterfactual-twin-execution.ts';
import type { DistributedWorkFence } from './distributed-fabric.ts';
import type { EnterpriseAuthorityPath } from './enterprise-control-plane.ts';
import { OperatorError } from './errors.ts';
import type { ProofBundleVerification } from './proof-bundle.ts';

export type AutonomousEngineeringOsStatus =
  | 'BLOCKED'
  | 'READY_TO_EXECUTE'
  | 'AWAITING_REVIEW'
  | 'CERTIFIED';

export interface HumanOutcomeReview {
  principalId: string;
  approved: boolean;
  reviewedAt: string;
  noteDigest?: string;
}

export interface AutonomousEngineeringOsRecord {
  schemaVersion: 1;
  id: string;
  objectiveId: string;
  goalDigest: string;
  constraintsDigest: string;
  workspaceGraphId: string;
  planDigest: string;
  authorityDigest: string;
  authorityLeaseId: string;
  twinReceiptId?: string;
  distributedFenceId?: string;
  evidencePackId?: string;
  proofBundleId?: string;
  certificationId?: string;
  status: AutonomousEngineeringOsStatus;
  reasons: string[];
  humanReview?: HumanOutcomeReview;
  learningEligible: boolean;
  createdAt: string;
}

export interface AutonomousEngineeringInputs {
  objectiveId: string;
  goalDigest: string;
  constraintsDigest: string;
  workspaceGraphId: string;
  planDigest: string;
  authority: EnterpriseAuthorityPath;
  twinSelection?: CounterfactualSelection;
  twinReceipts?: CounterfactualTwinReceipt[];
  distributedFence?: DistributedWorkFence;
  proofVerification?: ProofBundleVerification;
  objectiveCertification?: AutonomousObjectiveCertification;
  humanReview?: HumanOutcomeReview;
  requireTwin?: boolean;
  requireDistributedFence?: boolean;
  requireHumanReview?: boolean;
  createdAt?: string;
}

export function evaluateAutonomousEngineeringOs(input: AutonomousEngineeringInputs): AutonomousEngineeringOsRecord {
  const objectiveId = id(input.objectiveId, 'objectiveId');
  const goalDigest = digest(input.goalDigest, 'goalDigest');
  const constraintsDigest = digest(input.constraintsDigest, 'constraintsDigest');
  const workspaceGraphId = digest(input.workspaceGraphId, 'workspaceGraphId');
  const planDigest = digest(input.planDigest, 'planDigest');
  const authority = normalizeAuthority(input.authority);
  const reasons: string[] = [];

  let twinReceiptId: string | undefined;
  if (input.requireTwin ?? true) {
    const selectedId = input.twinSelection?.selectedAlternativeId;
    const receiptId = input.twinSelection?.receiptId;
    if (!selectedId || !receiptId) reasons.push('COUNTERFACTUAL_TWIN_NOT_SELECTED');
    else {
      const receipts = input.twinReceipts ?? [];
      const receipt = receipts.find((item) => item.id === receiptId && item.alternativeId === selectedId);
      if (!receipt || receipt.status !== 'PASSED') reasons.push('COUNTERFACTUAL_TWIN_RECEIPT_INVALID');
      else twinReceiptId = digest(receipt.id, 'twinReceiptId');
    }
  }

  let distributedFenceId: string | undefined;
  if (input.requireDistributedFence ?? true) {
    const fence = input.distributedFence;
    if (!fence || fence.state !== 'ACTIVE') reasons.push('DISTRIBUTED_FENCE_MISSING');
    else {
      if (fence.objectiveId !== objectiveId) reasons.push('DISTRIBUTED_FENCE_OBJECTIVE_MISMATCH');
      if (fence.authorityDigest !== authority.authorityDigest) reasons.push('DISTRIBUTED_FENCE_AUTHORITY_MISMATCH');
      distributedFenceId = digest(fence.id, 'distributedFenceId');
    }
  }

  const proof = input.proofVerification;
  if (!proof || proof.status !== 'VALID' || !proof.signatureVerified || !proof.requiredClaimsSatisfied) {
    reasons.push('MACHINE_PROOF_NOT_VALID');
  }

  const certification = input.objectiveCertification;
  if (!certification || certification.status !== 'CERTIFIED') {
    reasons.push('OBJECTIVE_NOT_CERTIFIED');
  }

  const evidencePackId = certification?.evidencePackId;
  if (!evidencePackId) reasons.push('EVIDENCE_PACK_MISSING');

  let humanReview: HumanOutcomeReview | undefined;
  const requireHumanReview = input.requireHumanReview ?? true;
  if (input.humanReview) humanReview = normalizeHumanReview(input.humanReview);
  if (requireHumanReview && !humanReview?.approved) reasons.push('HUMAN_REVIEW_REQUIRED');

  let status: AutonomousEngineeringOsStatus;
  if (reasons.length > 0) {
    const onlyReview = reasons.length === 1 && reasons[0] === 'HUMAN_REVIEW_REQUIRED';
    status = onlyReview ? 'AWAITING_REVIEW' : 'BLOCKED';
  } else {
    status = 'CERTIFIED';
  }

  const learningEligible =
    status === 'CERTIFIED' &&
    proof?.status === 'VALID' &&
    certification?.status === 'CERTIFIED' &&
    (humanReview?.approved ?? !requireHumanReview);

  const body = {
    schemaVersion: 1 as const,
    objectiveId,
    goalDigest,
    constraintsDigest,
    workspaceGraphId,
    planDigest,
    authorityDigest: authority.authorityDigest,
    authorityLeaseId: authority.leaseId,
    ...(twinReceiptId ? { twinReceiptId } : {}),
    ...(distributedFenceId ? { distributedFenceId } : {}),
    ...(evidencePackId ? { evidencePackId: digest(evidencePackId, 'evidencePackId') } : {}),
    ...(proof?.bundleId ? { proofBundleId: digest(proof.bundleId, 'proofBundleId') } : {}),
    ...(certification?.sessionId ? { certificationId: certificationIdentity(certification) } : {}),
    status,
    reasons: [...new Set(reasons)].sort(),
    ...(humanReview ? { humanReview } : {}),
    learningEligible,
    createdAt: iso(input.createdAt ?? new Date().toISOString(), 'createdAt')
  };
  return { ...body, id: sha256(canonicalJson(body)) };
}

export function autonomousLearningDecision(recordInput: AutonomousEngineeringOsRecord): {
  allowed: boolean;
  reason: 'CERTIFIED_RECEIPT' | 'NOT_CERTIFIED' | 'REVIEW_MISSING' | 'PROOF_OR_EVIDENCE_MISSING';
} {
  const record = validateAutonomousEngineeringOsRecord(recordInput);
  if (record.status !== 'CERTIFIED') return { allowed: false, reason: 'NOT_CERTIFIED' };
  if (!record.humanReview?.approved) return { allowed: false, reason: 'REVIEW_MISSING' };
  if (!record.proofBundleId || !record.evidencePackId || !record.certificationId) {
    return { allowed: false, reason: 'PROOF_OR_EVIDENCE_MISSING' };
  }
  return record.learningEligible
    ? { allowed: true, reason: 'CERTIFIED_RECEIPT' }
    : { allowed: false, reason: 'NOT_CERTIFIED' };
}

export function validateAutonomousEngineeringOsRecord(input: AutonomousEngineeringOsRecord): AutonomousEngineeringOsRecord {
  if (!input || input.schemaVersion !== 1 || typeof input.id !== 'string') throw invalid('Autonomous Engineering OS record shape is invalid.');
  const body = {
    schemaVersion: 1 as const,
    objectiveId: id(input.objectiveId, 'objectiveId'),
    goalDigest: digest(input.goalDigest, 'goalDigest'),
    constraintsDigest: digest(input.constraintsDigest, 'constraintsDigest'),
    workspaceGraphId: digest(input.workspaceGraphId, 'workspaceGraphId'),
    planDigest: digest(input.planDigest, 'planDigest'),
    authorityDigest: digest(input.authorityDigest, 'authorityDigest'),
    authorityLeaseId: digest(input.authorityLeaseId, 'authorityLeaseId'),
    ...(input.twinReceiptId ? { twinReceiptId: digest(input.twinReceiptId, 'twinReceiptId') } : {}),
    ...(input.distributedFenceId ? { distributedFenceId: digest(input.distributedFenceId, 'distributedFenceId') } : {}),
    ...(input.evidencePackId ? { evidencePackId: digest(input.evidencePackId, 'evidencePackId') } : {}),
    ...(input.proofBundleId ? { proofBundleId: digest(input.proofBundleId, 'proofBundleId') } : {}),
    ...(input.certificationId ? { certificationId: digest(input.certificationId, 'certificationId') } : {}),
    status: normalizeStatus(input.status),
    reasons: uniqueReasons(input.reasons),
    ...(input.humanReview ? { humanReview: normalizeHumanReview(input.humanReview) } : {}),
    learningEligible: boolean(input.learningEligible, 'learningEligible'),
    createdAt: iso(input.createdAt, 'createdAt')
  };
  const expected = sha256(canonicalJson(body));
  if (digest(input.id, 'record.id') !== expected) throw invalid('Autonomous Engineering OS record id does not match its content.');
  return { ...body, id: expected };
}

function normalizeAuthority(input: EnterpriseAuthorityPath): EnterpriseAuthorityPath {
  if (!input || input.schemaVersion !== 1) throw invalid('Enterprise authority path is invalid.');
  return {
    schemaVersion: 1,
    principalId: id(input.principalId, 'authority.principalId'),
    leaseId: digest(input.leaseId, 'authority.leaseId'),
    delegationId: id(input.delegationId, 'authority.delegationId'),
    purpose: text(input.purpose, 2048, 'authority.purpose'),
    authorityDigest: digest(input.authorityDigest, 'authority.authorityDigest'),
    approverPrincipalIds: uniqueIds(input.approverPrincipalIds, 'authority.approverPrincipalIds'),
    expiresAt: iso(input.expiresAt, 'authority.expiresAt'),
    emergencyEpoch: integer(input.emergencyEpoch, 1, Number.MAX_SAFE_INTEGER, 'authority.emergencyEpoch')
  };
}

function normalizeHumanReview(input: HumanOutcomeReview): HumanOutcomeReview {
  if (!input || typeof input !== 'object') throw invalid('Human review is invalid.');
  return {
    principalId: id(input.principalId, 'humanReview.principalId'),
    approved: boolean(input.approved, 'humanReview.approved'),
    reviewedAt: iso(input.reviewedAt, 'humanReview.reviewedAt'),
    ...(input.noteDigest ? { noteDigest: digest(input.noteDigest, 'humanReview.noteDigest') } : {})
  };
}

function certificationIdentity(input: AutonomousObjectiveCertification): string {
  return sha256(canonicalJson({
    schemaVersion: input.schemaVersion,
    sessionId: input.sessionId,
    status: input.status,
    reasons: [...input.reasons].sort(),
    evidencePackId: input.evidencePackId ?? null
  }));
}

function normalizeStatus(input: unknown): AutonomousEngineeringOsStatus {
  if (!['BLOCKED','READY_TO_EXECUTE','AWAITING_REVIEW','CERTIFIED'].includes(String(input))) throw invalid('status is invalid.');
  return input as AutonomousEngineeringOsStatus;
}
function uniqueReasons(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 1000) throw invalid('reasons are invalid.');
  return [...new Set(input.map((item) => {
    const value = String(item ?? '');
    if (!/^[A-Z0-9_:-]{1,256}$/.test(value)) throw invalid('reason code is invalid.');
    return value;
  }))].sort();
}
function uniqueIds(input: unknown, label: string): string[] {
  if (!Array.isArray(input) || input.length > 64) throw invalid(label + ' is invalid.');
  return [...new Set(input.map((item) => id(item, label)))].sort();
}
function id(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!/^[A-Za-z0-9._:@/+-=]{1,256}$/.test(value)) throw invalid(label + ' is invalid.');
  return value;
}
function digest(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw invalid(label + ' must be SHA-256.');
  return value;
}
function text(input: unknown, maxBytes: number, label: string): string {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0') || Buffer.byteLength(input, 'utf8') > maxBytes) throw invalid(label + ' is invalid.');
  return input.trim();
}
function iso(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!value || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw invalid(label + ' must be canonical ISO.');
  return value;
}
function integer(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(label + ' is invalid.');
  return value;
}
function boolean(input: unknown, label: string): boolean {
  if (typeof input !== 'boolean') throw invalid(label + ' must be boolean.');
  return input;
}
function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
function invalid(message: string): OperatorError {
  return new OperatorError('AUTONOMOUS_ENGINEERING_OS_INVALID', message);
}
