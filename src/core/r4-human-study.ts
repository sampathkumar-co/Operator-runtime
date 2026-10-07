import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';

export interface R4HumanStudySessionBody {
  schemaVersion: 1;
  participantId: string;
  sourceSha: string;
  environmentDigest: string;
  externalParticipant: boolean;
  preparedParticipant: boolean;
  consentRecorded: boolean;
  startedAt: string;
  verifiedTaskAt?: string;
  primaryWorkflowCompleted: boolean;
  developerAssistanceEvents: string[];
  onboarding: {
    install: boolean;
    doctor: boolean;
    authenticate: boolean;
    pair: boolean;
    roots: boolean;
    readProbe: boolean;
    approvalProbe: boolean;
    guidedVerifiedTask: boolean;
  };
  approvalComprehension: {
    completedWithoutDocs: boolean;
    requestedEffect: boolean;
    scope: boolean;
    risk: boolean;
    reversibility: boolean;
    alternatives: boolean;
    exactResource: boolean;
    expiry: boolean;
    reason: boolean;
  };
  recoveryComprehension: {
    retryable: boolean;
    reconcilable: boolean;
    reversible: boolean;
    blocked: boolean;
    terminal: boolean;
    uncertain: boolean;
  };
  proofInspection: {
    opened: boolean;
    identifiedAuthority: boolean;
    identifiedActionEffect: boolean;
    identifiedVerification: boolean;
  };
  causalTimelineUnderstood: boolean;
}

export interface R4HumanStudySession {
  body: R4HumanStudySessionBody;
  digest: string;
}

export interface R4HumanStudyStandard {
  minExternalPreparedParticipants: number;
  minPrimaryWorkflowCompletionRate: number;
  minAssistanceFreeCompletionRate: number;
  minApprovalComprehensionRate: number;
  minRecoveryComprehensionRate: number;
  minProofInspectionRate: number;
  minCausalTimelineComprehensionRate: number;
  maxMedianMinutesToVerifiedTask: number;
  maxP90MinutesToVerifiedTask: number;
}

export interface R4HumanStudyReport {
  schemaVersion: 1;
  sourceSha: string;
  participantCount: number;
  eligibleParticipantCount: number;
  completionRate: number;
  assistanceFreeCompletionRate: number;
  approvalComprehensionRate: number;
  recoveryComprehensionRate: number;
  proofInspectionRate: number;
  causalTimelineComprehensionRate: number;
  medianMinutesToVerifiedTask: number | null;
  p90MinutesToVerifiedTask: number | null;
  standard: R4HumanStudyStandard;
  status: 'CERTIFIED' | 'NOT_CERTIFIED';
  reasons: string[];
  sessionDigests: string[];
  reportDigest: string;
}

const APPROVAL_FIELDS = ['requestedEffect','scope','risk','reversibility','alternatives','exactResource','expiry','reason'] as const;
const RECOVERY_FIELDS = ['retryable','reconcilable','reversible','blocked','terminal','uncertain'] as const;

export const DEFAULT_R4_HUMAN_STUDY_STANDARD: R4HumanStudyStandard = Object.freeze({
  minExternalPreparedParticipants: 5,
  minPrimaryWorkflowCompletionRate: 0.8,
  minAssistanceFreeCompletionRate: 0.8,
  minApprovalComprehensionRate: 0.9,
  minRecoveryComprehensionRate: 0.85,
  minProofInspectionRate: 0.8,
  minCausalTimelineComprehensionRate: 0.8,
  maxMedianMinutesToVerifiedTask: 20,
  maxP90MinutesToVerifiedTask: 45
});

export function createR4HumanStudySession(input: R4HumanStudySessionBody): R4HumanStudySession {
  const body = normalizeBody(input);
  return { body, digest: hash(body) };
}

export function verifyR4HumanStudySession(input: R4HumanStudySession): boolean {
  try {
    const body = normalizeBody(input.body);
    return digest(input.digest, 'session digest') === hash(body);
  } catch {
    return false;
  }
}

export function certifyR4HumanStudy(input: {
  sourceSha: string;
  sessions: R4HumanStudySession[];
  standard?: Partial<R4HumanStudyStandard>;
}): R4HumanStudyReport {
  const sourceSha = gitSha(input.sourceSha, 'sourceSha');
  if (!Array.isArray(input.sessions) || input.sessions.length > 10_000) throw invalid('Study sessions are invalid.');
  const standard = normalizeStandard({ ...DEFAULT_R4_HUMAN_STUDY_STANDARD, ...(input.standard ?? {}) });
  const seen = new Set<string>();
  const sessions = input.sessions.map((session) => {
    if (!verifyR4HumanStudySession(session)) throw invalid('Study session digest verification failed.');
    const normalized = createR4HumanStudySession(session.body);
    if (normalized.body.sourceSha !== sourceSha) throw invalid('Study session source SHA does not match certification source SHA.');
    if (seen.has(normalized.body.participantId)) throw invalid('Participant IDs must be unique.');
    seen.add(normalized.body.participantId);
    return normalized;
  });

  const eligible = sessions.filter((session) =>
    session.body.externalParticipant &&
    session.body.preparedParticipant &&
    session.body.consentRecorded
  );

  const completed = eligible.filter((session) => session.body.primaryWorkflowCompleted);
  const assistanceFree = completed.filter((session) => session.body.developerAssistanceEvents.length === 0);
  const approvalPassing = eligible.filter((session) =>
    session.body.approvalComprehension.completedWithoutDocs &&
    APPROVAL_FIELDS.every((field) => session.body.approvalComprehension[field])
  );
  const recoveryPassing = eligible.filter((session) =>
    RECOVERY_FIELDS.every((field) => session.body.recoveryComprehension[field])
  );
  const proofPassing = eligible.filter((session) => {
    const proof = session.body.proofInspection;
    return proof.opened && proof.identifiedAuthority && proof.identifiedActionEffect && proof.identifiedVerification;
  });
  const causalPassing = eligible.filter((session) => session.body.causalTimelineUnderstood);
  const times = completed
    .map((session) => minutesBetween(session.body.startedAt, session.body.verifiedTaskAt!))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  const completionRate = rate(completed.length, eligible.length);
  const assistanceFreeCompletionRate = rate(assistanceFree.length, eligible.length);
  const approvalComprehensionRate = rate(approvalPassing.length, eligible.length);
  const recoveryComprehensionRate = rate(recoveryPassing.length, eligible.length);
  const proofInspectionRate = rate(proofPassing.length, eligible.length);
  const causalTimelineComprehensionRate = rate(causalPassing.length, eligible.length);
  const medianMinutesToVerifiedTask = times.length ? percentile(times, 0.5) : null;
  const p90MinutesToVerifiedTask = times.length ? percentile(times, 0.9) : null;

  const reasons: string[] = [];
  if (eligible.length < standard.minExternalPreparedParticipants) reasons.push('insufficient external prepared participant count');
  if (completionRate < standard.minPrimaryWorkflowCompletionRate) reasons.push('primary workflow completion rate is below standard');
  if (assistanceFreeCompletionRate < standard.minAssistanceFreeCompletionRate) reasons.push('assistance-free completion rate is below standard');
  if (approvalComprehensionRate < standard.minApprovalComprehensionRate) reasons.push('approval comprehension is below standard');
  if (recoveryComprehensionRate < standard.minRecoveryComprehensionRate) reasons.push('recovery comprehension is below standard');
  if (proofInspectionRate < standard.minProofInspectionRate) reasons.push('proof inspection comprehension is below standard');
  if (causalTimelineComprehensionRate < standard.minCausalTimelineComprehensionRate) reasons.push('causal timeline comprehension is below standard');
  if (medianMinutesToVerifiedTask === null || medianMinutesToVerifiedTask > standard.maxMedianMinutesToVerifiedTask) reasons.push('median time-to-first-verified-task exceeds standard');
  if (p90MinutesToVerifiedTask === null || p90MinutesToVerifiedTask > standard.maxP90MinutesToVerifiedTask) reasons.push('p90 time-to-first-verified-task exceeds standard');

  const base = {
    schemaVersion: 1 as const,
    sourceSha,
    participantCount: sessions.length,
    eligibleParticipantCount: eligible.length,
    completionRate,
    assistanceFreeCompletionRate,
    approvalComprehensionRate,
    recoveryComprehensionRate,
    proofInspectionRate,
    causalTimelineComprehensionRate,
    medianMinutesToVerifiedTask,
    p90MinutesToVerifiedTask,
    standard,
    status: reasons.length === 0 ? 'CERTIFIED' as const : 'NOT_CERTIFIED' as const,
    reasons,
    sessionDigests: sessions.map((session) => session.digest).sort()
  };
  return { ...base, reportDigest: hash(base) };
}

function normalizeBody(input: R4HumanStudySessionBody): R4HumanStudySessionBody {
  if (!input || input.schemaVersion !== 1) throw invalid('Study session schemaVersion must be 1.');
  const startedAt = iso(input.startedAt, 'startedAt');
  const verifiedTaskAt = input.verifiedTaskAt === undefined ? undefined : iso(input.verifiedTaskAt, 'verifiedTaskAt');
  if (verifiedTaskAt && Date.parse(verifiedTaskAt) < Date.parse(startedAt)) throw invalid('verifiedTaskAt precedes startedAt.');
  if (input.primaryWorkflowCompleted !== Boolean(verifiedTaskAt)) throw invalid('Completed workflow must bind a verified-task timestamp.');
  const onboarding = input.onboarding;
  const approval = input.approvalComprehension;
  const recovery = input.recoveryComprehension;
  const proof = input.proofInspection;
  if (!onboarding || !approval || !recovery || !proof) throw invalid('Study session sections are incomplete.');
  return {
    schemaVersion: 1,
    participantId: id(input.participantId, 'participantId'),
    sourceSha: gitSha(input.sourceSha, 'sourceSha'),
    environmentDigest: digest(input.environmentDigest, 'environmentDigest'),
    externalParticipant: bool(input.externalParticipant, 'externalParticipant'),
    preparedParticipant: bool(input.preparedParticipant, 'preparedParticipant'),
    consentRecorded: bool(input.consentRecorded, 'consentRecorded'),
    startedAt,
    ...(verifiedTaskAt ? { verifiedTaskAt } : {}),
    primaryWorkflowCompleted: bool(input.primaryWorkflowCompleted, 'primaryWorkflowCompleted'),
    developerAssistanceEvents: list(input.developerAssistanceEvents, 100, 1024, 'developerAssistanceEvents'),
    onboarding: {
      install: bool(onboarding.install, 'onboarding.install'),
      doctor: bool(onboarding.doctor, 'onboarding.doctor'),
      authenticate: bool(onboarding.authenticate, 'onboarding.authenticate'),
      pair: bool(onboarding.pair, 'onboarding.pair'),
      roots: bool(onboarding.roots, 'onboarding.roots'),
      readProbe: bool(onboarding.readProbe, 'onboarding.readProbe'),
      approvalProbe: bool(onboarding.approvalProbe, 'onboarding.approvalProbe'),
      guidedVerifiedTask: bool(onboarding.guidedVerifiedTask, 'onboarding.guidedVerifiedTask')
    },
    approvalComprehension: {
      completedWithoutDocs: bool(approval.completedWithoutDocs, 'approval.completedWithoutDocs'),
      requestedEffect: bool(approval.requestedEffect, 'approval.requestedEffect'),
      scope: bool(approval.scope, 'approval.scope'),
      risk: bool(approval.risk, 'approval.risk'),
      reversibility: bool(approval.reversibility, 'approval.reversibility'),
      alternatives: bool(approval.alternatives, 'approval.alternatives'),
      exactResource: bool(approval.exactResource, 'approval.exactResource'),
      expiry: bool(approval.expiry, 'approval.expiry'),
      reason: bool(approval.reason, 'approval.reason')
    },
    recoveryComprehension: {
      retryable: bool(recovery.retryable, 'recovery.retryable'),
      reconcilable: bool(recovery.reconcilable, 'recovery.reconcilable'),
      reversible: bool(recovery.reversible, 'recovery.reversible'),
      blocked: bool(recovery.blocked, 'recovery.blocked'),
      terminal: bool(recovery.terminal, 'recovery.terminal'),
      uncertain: bool(recovery.uncertain, 'recovery.uncertain')
    },
    proofInspection: {
      opened: bool(proof.opened, 'proof.opened'),
      identifiedAuthority: bool(proof.identifiedAuthority, 'proof.identifiedAuthority'),
      identifiedActionEffect: bool(proof.identifiedActionEffect, 'proof.identifiedActionEffect'),
      identifiedVerification: bool(proof.identifiedVerification, 'proof.identifiedVerification')
    },
    causalTimelineUnderstood: bool(input.causalTimelineUnderstood, 'causalTimelineUnderstood')
  };
}

function normalizeStandard(input: R4HumanStudyStandard): R4HumanStudyStandard {
  return {
    minExternalPreparedParticipants: integer(input.minExternalPreparedParticipants, 1, 10_000, 'minExternalPreparedParticipants'),
    minPrimaryWorkflowCompletionRate: probability(input.minPrimaryWorkflowCompletionRate, 'minPrimaryWorkflowCompletionRate'),
    minAssistanceFreeCompletionRate: probability(input.minAssistanceFreeCompletionRate, 'minAssistanceFreeCompletionRate'),
    minApprovalComprehensionRate: probability(input.minApprovalComprehensionRate, 'minApprovalComprehensionRate'),
    minRecoveryComprehensionRate: probability(input.minRecoveryComprehensionRate, 'minRecoveryComprehensionRate'),
    minProofInspectionRate: probability(input.minProofInspectionRate, 'minProofInspectionRate'),
    minCausalTimelineComprehensionRate: probability(input.minCausalTimelineComprehensionRate, 'minCausalTimelineComprehensionRate'),
    maxMedianMinutesToVerifiedTask: positive(input.maxMedianMinutesToVerifiedTask, 'maxMedianMinutesToVerifiedTask'),
    maxP90MinutesToVerifiedTask: positive(input.maxP90MinutesToVerifiedTask, 'maxP90MinutesToVerifiedTask')
  };
}
function minutesBetween(start: string, end: string): number { return (Date.parse(end) - Date.parse(start)) / 60_000; }
function percentile(sorted: number[], p: number): number {
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index), upper = Math.ceil(index);
  if (lower === upper) return round(sorted[lower]!);
  return round(sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower));
}
function rate(n: number, d: number): number { return d === 0 ? 0 : round(n / d); }
function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
function bool(value: unknown, label: string): boolean { if (typeof value !== 'boolean') throw invalid(label + ' is invalid.'); return value; }
function integer(value: unknown, min: number, max: number, label: string): number { const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) throw invalid(label + ' is invalid.'); return n; }
function positive(value: unknown, label: string): number { const n = Number(value); if (!Number.isFinite(n) || n <= 0) throw invalid(label + ' is invalid.'); return n; }
function probability(value: unknown, label: string): number { const n = Number(value); if (!Number.isFinite(n) || n < 0 || n > 1) throw invalid(label + ' is invalid.'); return n; }
function id(value: unknown, label: string): string { const s = String(value ?? ''); if (!/^[A-Za-z0-9._:@/+-]{1,256}$/.test(s)) throw invalid(label + ' is invalid.'); return s; }
function list(value: unknown, maxItems: number, maxBytes: number, label: string): string[] { if (!Array.isArray(value) || value.length > maxItems) throw invalid(label + ' is invalid.'); return value.map((item) => { if (typeof item !== 'string' || Buffer.byteLength(item, 'utf8') > maxBytes || item.includes('\0')) throw invalid(label + ' is invalid.'); return item; }); }
function gitSha(value: unknown, label: string): string { const s = String(value ?? '').toLowerCase(); if (!/^[0-9a-f]{40}$/.test(s)) throw invalid(label + ' must be a git SHA.'); return s; }
function digest(value: unknown, label: string): string { const s = String(value ?? '').toLowerCase(); if (!/^[0-9a-f]{64}$/.test(s)) throw invalid(label + ' must be SHA-256.'); return s; }
function iso(value: unknown, label: string): string { const s = String(value ?? ''); if (!Number.isFinite(Date.parse(s)) || new Date(s).toISOString() !== s) throw invalid(label + ' must be canonical ISO.'); return s; }
function hash(value: unknown): string { return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex'); }
function invalid(message: string): OperatorError { return new OperatorError('R4_HUMAN_STUDY_INVALID', message); }
