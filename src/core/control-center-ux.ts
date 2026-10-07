import { OperatorError } from './errors.ts';
import type { ActionRisk, ExecutionPhase, SideEffectState } from './types.ts';

export type ApprovalUiStatus = 'PENDING' | 'APPROVED' | 'IN_USE' | 'CONSUMED' | 'DENIED' | 'EXPIRED';

export interface ApprovalCenterRecordInput {
  actionId: string;
  approvalRequestId: string;
  capability: string;
  risk: ActionRisk;
  target?: string;
  status: 'pending' | 'approved' | 'consumed' | 'denied';
  createdAt: string;
  pendingExpiresAt: string;
  approvalExpiresAt?: string;
  consumedAt?: string;
  deniedAt?: string;
  executionLeaseId?: string;
  executionLeaseExpiresAt?: string;
}

export interface ApprovalCenterItem {
  actionId: string;
  approvalRequestId: string;
  capability: string;
  risk: ActionRisk;
  target?: string;
  status: ApprovalUiStatus;
  effectClass: 'OBSERVE' | 'LOCAL_MUTATION' | 'EXTERNAL_EFFECT' | 'SYSTEM_CHANGE' | 'DESTRUCTIVE_EFFECT';
  reversibility: 'NOT_APPLICABLE' | 'CHECKPOINT_RECOMMENDED' | 'COMPENSATION_REQUIRED' | 'ROLLBACK_REQUIRED' | 'MAY_BE_IRREVERSIBLE';
  reason: string;
  expiresAt?: string;
  secondsRemaining?: number;
  canApprove: boolean;
  canDeny: boolean;
  executing: boolean;
  requestedAt: string;
}

export interface ApprovalCenterModel {
  schemaVersion: 1;
  pending: ApprovalCenterItem[];
  active: ApprovalCenterItem[];
  history: ApprovalCenterItem[];
  counts: {
    pending: number;
    approved: number;
    inUse: number;
    consumed: number;
    denied: number;
    expired: number;
  };
}

export type RecoveryDisposition =
  | 'RETRYABLE'
  | 'RECONCILABLE'
  | 'REVERSIBLE'
  | 'BLOCKED'
  | 'TERMINAL'
  | 'UNCERTAIN';

export type RecoveryAction = 'RETRY' | 'RECONCILE' | 'ROLLBACK' | 'ESCALATE' | 'NONE';

export interface RecoveryCandidateInput {
  actionId: string;
  capability: string;
  target?: string;
  retryable: boolean;
  sideEffectState: SideEffectState;
  executionPhase?: ExecutionPhase;
  reconciliationStatus?: 'completed' | 'not_applied' | 'uncertain';
  rollbackAvailable?: boolean;
  verificationStatus?: 'passed' | 'failed' | 'unknown';
  code?: string;
  updatedAt: string;
}

export interface RecoveryCenterItem {
  actionId: string;
  capability: string;
  target?: string;
  disposition: RecoveryDisposition;
  recommendedAction: RecoveryAction;
  requiresFreshApproval: boolean;
  reason: string;
  code?: string;
  updatedAt: string;
}

export interface RecoveryCenterModel {
  schemaVersion: 1;
  items: RecoveryCenterItem[];
  counts: Record<RecoveryDisposition, number>;
}

export type OnboardingStepId =
  | 'INSTALL'
  | 'DOCTOR'
  | 'AUTHENTICATE'
  | 'PAIR_DEVICE'
  | 'CONFIGURE_ROOTS'
  | 'READ_PROBE'
  | 'APPROVAL_PROBE'
  | 'GUIDED_VERIFIED_TASK';

export interface OnboardingStateInput {
  runtimeInstalled: boolean;
  doctorHealthy: boolean;
  authenticated: boolean;
  devicePaired: boolean;
  rootsConfigured: boolean;
  readProbePassed: boolean;
  approvalProbePassed: boolean;
  guidedTaskVerified: boolean;
}

export interface OnboardingStep {
  id: OnboardingStepId;
  status: 'COMPLETE' | 'READY' | 'BLOCKED';
  blockingStep?: OnboardingStepId;
}

export interface GuidedOnboardingModel {
  schemaVersion: 1;
  completed: boolean;
  nextStep?: OnboardingStepId;
  steps: OnboardingStep[];
}

const RISKS: ActionRisk[] = ['read', 'write', 'external', 'system', 'destructive'];
const DISPOSITIONS: RecoveryDisposition[] = ['RETRYABLE','RECONCILABLE','REVERSIBLE','BLOCKED','TERMINAL','UNCERTAIN'];

export function buildApprovalCenterModel(
  recordsInput: ApprovalCenterRecordInput[],
  nowInput = new Date().toISOString()
): ApprovalCenterModel {
  if (!Array.isArray(recordsInput) || recordsInput.length > 10_000) {
    throw invalid('Approval Center records are invalid.');
  }
  const now = canonicalIso(nowInput, 'now');
  const nowMs = Date.parse(now);
  const seen = new Set<string>();
  const items = recordsInput.map((raw) => {
    const record = normalizeApprovalRecord(raw);
    if (seen.has(record.actionId)) throw invalid('Approval Center contains duplicate actionId.');
    seen.add(record.actionId);
    return approvalItem(record, nowMs);
  }).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || a.actionId.localeCompare(b.actionId));

  const pending = items.filter((item) => item.status === 'PENDING');
  const active = items.filter((item) => item.status === 'APPROVED' || item.status === 'IN_USE');
  const history = items.filter((item) => !pending.includes(item) && !active.includes(item));
  const count = (status: ApprovalUiStatus) => items.filter((item) => item.status === status).length;
  return {
    schemaVersion: 1,
    pending,
    active,
    history,
    counts: {
      pending: count('PENDING'),
      approved: count('APPROVED'),
      inUse: count('IN_USE'),
      consumed: count('CONSUMED'),
      denied: count('DENIED'),
      expired: count('EXPIRED')
    }
  };
}

export function buildRecoveryCenterModel(
  candidatesInput: RecoveryCandidateInput[]
): RecoveryCenterModel {
  if (!Array.isArray(candidatesInput) || candidatesInput.length > 10_000) {
    throw invalid('Recovery Center candidates are invalid.');
  }
  const seen = new Set<string>();
  const items = candidatesInput.map((candidate) => {
    const normalized = normalizeRecoveryCandidate(candidate);
    if (seen.has(normalized.actionId)) throw invalid('Recovery Center contains duplicate actionId.');
    seen.add(normalized.actionId);
    return recoveryItem(normalized);
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.actionId.localeCompare(b.actionId));

  const counts = Object.fromEntries(DISPOSITIONS.map((item) => [item, 0])) as Record<RecoveryDisposition, number>;
  for (const item of items) counts[item.disposition] += 1;
  return { schemaVersion: 1, items, counts };
}

export function buildGuidedOnboardingModel(input: OnboardingStateInput): GuidedOnboardingModel {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Onboarding state is invalid.');
  const ordered: Array<[OnboardingStepId, boolean]> = [
    ['INSTALL', boolean(input.runtimeInstalled, 'runtimeInstalled')],
    ['DOCTOR', boolean(input.doctorHealthy, 'doctorHealthy')],
    ['AUTHENTICATE', boolean(input.authenticated, 'authenticated')],
    ['PAIR_DEVICE', boolean(input.devicePaired, 'devicePaired')],
    ['CONFIGURE_ROOTS', boolean(input.rootsConfigured, 'rootsConfigured')],
    ['READ_PROBE', boolean(input.readProbePassed, 'readProbePassed')],
    ['APPROVAL_PROBE', boolean(input.approvalProbePassed, 'approvalProbePassed')],
    ['GUIDED_VERIFIED_TASK', boolean(input.guidedTaskVerified, 'guidedTaskVerified')]
  ];

  let firstIncomplete = ordered.findIndex(([, complete]) => !complete);
  if (firstIncomplete < 0) firstIncomplete = ordered.length;
  const steps: OnboardingStep[] = ordered.map(([id], index) => {
    if (index < firstIncomplete) return { id, status: 'COMPLETE' };
    if (index === firstIncomplete) return { id, status: 'READY' };
    return { id, status: 'BLOCKED', blockingStep: ordered[firstIncomplete]![0] };
  });
  return {
    schemaVersion: 1,
    completed: firstIncomplete === ordered.length,
    ...(firstIncomplete < ordered.length ? { nextStep: ordered[firstIncomplete]![0] } : {}),
    steps
  };
}

function approvalItem(record: ApprovalCenterRecordInput, nowMs: number): ApprovalCenterItem {
  const pendingExpiry = Date.parse(record.pendingExpiresAt);
  const approvalExpiry = record.approvalExpiresAt ? Date.parse(record.approvalExpiresAt) : undefined;
  const leaseExpiry = record.executionLeaseExpiresAt ? Date.parse(record.executionLeaseExpiresAt) : undefined;
  const executing = record.status === 'approved' && Boolean(record.executionLeaseId && leaseExpiry && leaseExpiry > nowMs);
  let status: ApprovalUiStatus;
  let expiresAt: string | undefined;

  if (record.status === 'pending') {
    if (pendingExpiry <= nowMs) status = 'EXPIRED';
    else {
      status = 'PENDING';
      expiresAt = record.pendingExpiresAt;
    }
  } else if (record.status === 'approved') {
    if (!approvalExpiry || approvalExpiry <= nowMs) status = 'EXPIRED';
    else {
      status = executing ? 'IN_USE' : 'APPROVED';
      expiresAt = record.approvalExpiresAt;
    }
  } else if (record.status === 'consumed') status = 'CONSUMED';
  else status = 'DENIED';

  return {
    actionId: record.actionId,
    approvalRequestId: record.approvalRequestId,
    capability: record.capability,
    risk: record.risk,
    ...(record.target ? { target: record.target } : {}),
    status,
    effectClass: effectClass(record.risk),
    reversibility: reversibility(record.risk),
    reason: approvalReason(record.risk),
    ...(expiresAt ? {
      expiresAt,
      secondsRemaining: Math.max(0, Math.ceil((Date.parse(expiresAt) - nowMs) / 1000))
    } : {}),
    canApprove: status === 'PENDING',
    canDeny: status === 'PENDING' || status === 'APPROVED',
    executing,
    requestedAt: record.createdAt
  };
}

function recoveryItem(candidate: RecoveryCandidateInput): RecoveryCenterItem {
  const base = {
    actionId: candidate.actionId,
    capability: candidate.capability,
    ...(candidate.target ? { target: candidate.target } : {}),
    ...(candidate.code ? { code: candidate.code } : {}),
    updatedAt: candidate.updatedAt
  };

  if (
    candidate.sideEffectState === 'uncertain' ||
    candidate.reconciliationStatus === 'uncertain'
  ) {
    return {
      ...base,
      disposition: 'UNCERTAIN',
      recommendedAction: candidate.reconciliationStatus === 'uncertain' ? 'ESCALATE' : 'RECONCILE',
      requiresFreshApproval: false,
      reason: candidate.reconciliationStatus === 'uncertain'
        ? 'Side effects remain uncertain after reconciliation; automatic retry is prohibited.'
        : 'Side effects are uncertain; reconcile current state before any retry or branch change.'
    };
  }

  if (candidate.reconciliationStatus === 'completed' && candidate.verificationStatus === 'passed') {
    return {
      ...base,
      disposition: 'TERMINAL',
      recommendedAction: 'NONE',
      requiresFreshApproval: false,
      reason: 'Reconciliation and independent verification already prove completion.'
    };
  }

  if (candidate.verificationStatus === 'failed' && candidate.rollbackAvailable) {
    return {
      ...base,
      disposition: 'REVERSIBLE',
      recommendedAction: 'ROLLBACK',
      requiresFreshApproval: true,
      reason: 'The effect is known but verification failed; a bounded rollback is available.'
    };
  }

  if (
    candidate.sideEffectState === 'none' &&
    candidate.retryable &&
    (candidate.reconciliationStatus === undefined || candidate.reconciliationStatus === 'not_applied')
  ) {
    return {
      ...base,
      disposition: 'RETRYABLE',
      recommendedAction: 'RETRY',
      requiresFreshApproval: true,
      reason: 'No side effect was applied and the failure is explicitly retryable.'
    };
  }

  if (candidate.sideEffectState === 'known' && candidate.rollbackAvailable) {
    return {
      ...base,
      disposition: 'REVERSIBLE',
      recommendedAction: 'ROLLBACK',
      requiresFreshApproval: true,
      reason: 'A known side effect exists and a bounded rollback is available.'
    };
  }

  if (candidate.retryable) {
    return {
      ...base,
      disposition: 'BLOCKED',
      recommendedAction: 'ESCALATE',
      requiresFreshApproval: false,
      reason: 'Retryability alone is insufficient because the side-effect state does not prove a safe retry.'
    };
  }

  return {
    ...base,
    disposition: 'TERMINAL',
    recommendedAction: 'ESCALATE',
    requiresFreshApproval: false,
    reason: 'No safe automatic recovery action is proven for this terminal failure.'
  };
}

function normalizeApprovalRecord(input: ApprovalCenterRecordInput): ApprovalCenterRecordInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Approval Center record is invalid.');
  const actionId = boundedId(input.actionId, 'actionId');
  const approvalRequestId = boundedId(input.approvalRequestId, 'approvalRequestId');
  const capability = boundedId(input.capability, 'capability');
  if (!RISKS.includes(input.risk)) throw invalid('Approval risk is invalid.');
  if (!['pending','approved','consumed','denied'].includes(input.status)) throw invalid('Approval status is invalid.');
  const createdAt = canonicalIso(input.createdAt, 'createdAt');
  const pendingExpiresAt = canonicalIso(input.pendingExpiresAt, 'pendingExpiresAt');
  if (Date.parse(pendingExpiresAt) <= Date.parse(createdAt)) throw invalid('Pending approval expiry is invalid.');
  const approvalExpiresAt = optionalIso(input.approvalExpiresAt, 'approvalExpiresAt');
  const consumedAt = optionalIso(input.consumedAt, 'consumedAt');
  const deniedAt = optionalIso(input.deniedAt, 'deniedAt');
  const executionLeaseExpiresAt = optionalIso(input.executionLeaseExpiresAt, 'executionLeaseExpiresAt');
  const executionLeaseId = input.executionLeaseId === undefined ? undefined : boundedId(input.executionLeaseId, 'executionLeaseId');
  if (Boolean(executionLeaseId) !== Boolean(executionLeaseExpiresAt)) throw invalid('Approval execution lease metadata is incomplete.');
  const target = input.target === undefined ? undefined : boundedText(input.target, 4096, 'target');
  return {
    actionId,
    approvalRequestId,
    capability,
    risk: input.risk,
    ...(target ? { target } : {}),
    status: input.status,
    createdAt,
    pendingExpiresAt,
    ...(approvalExpiresAt ? { approvalExpiresAt } : {}),
    ...(consumedAt ? { consumedAt } : {}),
    ...(deniedAt ? { deniedAt } : {}),
    ...(executionLeaseId ? { executionLeaseId, executionLeaseExpiresAt: executionLeaseExpiresAt! } : {})
  };
}

function normalizeRecoveryCandidate(input: RecoveryCandidateInput): RecoveryCandidateInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Recovery candidate is invalid.');
  const actionId = boundedId(input.actionId, 'actionId');
  const capability = boundedId(input.capability, 'capability');
  if (typeof input.retryable !== 'boolean') throw invalid('Recovery retryable flag is invalid.');
  if (!['none','known','uncertain'].includes(input.sideEffectState)) throw invalid('Recovery sideEffectState is invalid.');
  if (input.executionPhase !== undefined && !['pre_dispatch','dispatched','effect_observed','reconciled'].includes(input.executionPhase)) {
    throw invalid('Recovery executionPhase is invalid.');
  }
  if (input.reconciliationStatus !== undefined && !['completed','not_applied','uncertain'].includes(input.reconciliationStatus)) {
    throw invalid('Recovery reconciliationStatus is invalid.');
  }
  if (input.verificationStatus !== undefined && !['passed','failed','unknown'].includes(input.verificationStatus)) {
    throw invalid('Recovery verificationStatus is invalid.');
  }
  if (input.rollbackAvailable !== undefined && typeof input.rollbackAvailable !== 'boolean') throw invalid('Recovery rollbackAvailable is invalid.');
  const target = input.target === undefined ? undefined : boundedText(input.target, 4096, 'target');
  const code = input.code === undefined ? undefined : boundedId(input.code, 'code');
  return {
    actionId,
    capability,
    ...(target ? { target } : {}),
    retryable: input.retryable,
    sideEffectState: input.sideEffectState,
    ...(input.executionPhase ? { executionPhase: input.executionPhase } : {}),
    ...(input.reconciliationStatus ? { reconciliationStatus: input.reconciliationStatus } : {}),
    ...(input.rollbackAvailable !== undefined ? { rollbackAvailable: input.rollbackAvailable } : {}),
    ...(input.verificationStatus ? { verificationStatus: input.verificationStatus } : {}),
    ...(code ? { code } : {}),
    updatedAt: canonicalIso(input.updatedAt, 'updatedAt')
  };
}

function effectClass(risk: ActionRisk): ApprovalCenterItem['effectClass'] {
  if (risk === 'read') return 'OBSERVE';
  if (risk === 'write') return 'LOCAL_MUTATION';
  if (risk === 'external') return 'EXTERNAL_EFFECT';
  if (risk === 'system') return 'SYSTEM_CHANGE';
  return 'DESTRUCTIVE_EFFECT';
}

function reversibility(risk: ActionRisk): ApprovalCenterItem['reversibility'] {
  if (risk === 'read') return 'NOT_APPLICABLE';
  if (risk === 'write') return 'CHECKPOINT_RECOMMENDED';
  if (risk === 'external') return 'COMPENSATION_REQUIRED';
  if (risk === 'system') return 'ROLLBACK_REQUIRED';
  return 'MAY_BE_IRREVERSIBLE';
}

function approvalReason(risk: ActionRisk): string {
  if (risk === 'read') return 'Read-only action is shown for transparency; it does not require mutation authority.';
  if (risk === 'write') return 'This action mutates an authorized local resource and should preserve a verification/rollback path.';
  if (risk === 'external') return 'This action creates an external side effect and requires explicit user authority.';
  if (risk === 'system') return 'This action changes local system or tool state and requires explicit user authority.';
  return 'This action may be destructive or irreversible and requires explicit user authority plus postcondition verification.';
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalid(label + ' must be boolean.');
  return value;
}

function boundedId(value: unknown, label: string): string {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9._:@/+\-=]{1,512}$/.test(text)) throw invalid(label + ' is invalid.');
  return text;
}

function boundedText(value: unknown, maxBytes: number, label: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw invalid(label + ' is invalid.');
  }
  return value;
}

function canonicalIso(value: unknown, label: string): string {
  const text = String(value ?? '');
  if (!text || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) throw invalid(label + ' must be canonical ISO.');
  return text;
}

function optionalIso(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : canonicalIso(value, label);
}

function invalid(message: string): OperatorError {
  return new OperatorError('CONTROL_CENTER_UX_INVALID', message);
}
