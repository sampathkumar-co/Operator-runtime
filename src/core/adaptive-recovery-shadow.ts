import crypto from 'node:crypto';
import {
  selectRecovery,
  type FailureAttribution,
  type FailureClass,
  type RecoveryKind,
  type RecoveryOption
} from '../../packages/adaptive-intelligence/src/index.ts';
import { canonicalJson } from './action-identity.ts';
import type {
  TaskRecoveryShadowAdvisor,
  TaskRecoveryShadowRecommendation
} from './task-orchestrator.ts';

const POLICY_VERSION = 'adaptive-recovery-shadow-v1';
const FAILURE_CLASSES = new Set<FailureClass>([
  'PERCEPTION_INCOMPLETE', 'TARGET_AMBIGUOUS', 'TARGET_STALE', 'GEOMETRY_INVALID',
  'ACTION_CONTRACT_REJECTED', 'ACTION_NO_EFFECT', 'SIDE_EFFECT_UNCERTAIN',
  'GOAL_PROGRESS_FALSE_POSITIVE', 'PLANNER_STRATEGY_WRONG', 'MODEL_REASONING_WRONG',
  'PROVIDER_TRANSIENT', 'RESOURCE_CONTENTION', 'STATE_CHANGED_EXTERNALLY',
  'VERIFICATION_INSUFFICIENT', 'AUTHORITY_DENIED', 'BUDGET_EXHAUSTED', 'UNKNOWN'
]);
const RECOVERY_KINDS = new Set<RecoveryKind>([
  'REOBSERVE', 'REGROUND', 'REPLAN', 'REPAIR', 'RECONCILE', 'WAIT', 'VERIFY', 'FAIL_SAFE'
]);

/** Fourth progressive activation stage. Returns identities only and cannot execute a recovery. */
export class AdaptiveRecoveryShadowAdvisor implements TaskRecoveryShadowAdvisor {
  recommend(input: Parameters<TaskRecoveryShadowAdvisor['recommend']>[0]): TaskRecoveryShadowRecommendation {
    const failureClass = adaptiveFailureClass(input);
    const loopCount = semanticLoopCount(input.task.evidence, input.failedNodeId, failureClass);
    const attribution: FailureAttribution = {
      primary: { class: failureClass, probability: 1, reasons: ['Bound to authoritative production failure and normalized outcome evidence.'], evidence: [] },
      alternatives: [], entropy: 0,
      evidenceCoverage: input.outcomeAssessment?.failure?.evidenceCoverage ?? 0
    };
    const irreversible = input.risk === 'destructive' || input.risk === 'system';
    const options = recoveryOptions();
    const selected = loopCount >= 2
      ? { selected: options.find((option) => option.kind === 'FAIL_SAFE')!, alternatives: options.filter((option) => option.kind !== 'FAIL_SAFE') }
      : irreversible && input.sideEffectState !== 'uncertain'
        ? { selected: options.find((option) => option.kind === 'FAIL_SAFE')!, alternatives: options.filter((option) => option.kind !== 'FAIL_SAFE') }
        : selectRecovery({ attribution, options, remainingCostBudget: remainingBudget(input.task.execution?.maxSteps, input.task.execution?.stepCount) });
    const plan = planIdentity(input);
    const observationDigest = sha256(canonicalJson(input.observation));
    const verificationResultDigest = sha256(canonicalJson({
      ok: input.result.ok,
      capability: input.result.capability,
      provider: input.result.provider,
      errorCode: input.result.error?.code ?? null,
      sideEffectState: input.sideEffectState,
      executionPhase: input.executionPhase,
      evidenceRefs: input.observation.evidenceRefs
    }));
    const authoritySnapshotDigest = sha256(canonicalJson({
      allowedCapabilities: [...new Set(input.permissions.allowedCapabilities)].sort(),
      allowedRoots: [...new Set(input.permissions.allowedRoots)].sort(),
      maxRisk: input.permissions.maxRisk ?? null,
      allowExternalWrites: input.permissions.allowExternalWrites === true,
      allowSystemChanges: input.permissions.allowSystemChanges === true,
      allowDestructive: input.permissions.allowDestructive === true,
      enterprisePolicyDigest: input.permissions.enterprisePolicyDigest ?? null,
      enterprisePolicyGeneration: input.permissions.enterprisePolicyGeneration ?? null,
      intent: input.task.intent ?? null
    }));
    const inputStateDigest = sha256(canonicalJson({
      taskId: input.task.id, goalKind: input.goal.kind, planId: plan.id, planVersion: plan.version,
      planDigest: plan.digest, failedNodeId: input.failedNodeId, actionId: input.actionId,
      attempt: input.attempt, observationDigest, verificationResultDigest, authoritySnapshotDigest,
      failureClass, productionFailure: input.productionFailure, semanticLoopCount: loopCount
    }));
    const body: Omit<TaskRecoveryShadowRecommendation, 'recommendationDigest'> = {
      schemaVersion: 1, mode: 'SHADOW', policyVersion: POLICY_VERSION,
      taskId: input.task.id, goalKind: input.goal.kind,
      planId: plan.id, planVersion: plan.version, planDigest: plan.digest,
      failedNodeId: input.failedNodeId, actionId: input.actionId, attempt: input.attempt,
      observationDigest, verificationResultDigest, authoritySnapshotDigest,
      authorityGeneration: input.permissions.enterprisePolicyGeneration ?? null,
      inputStateDigest, failureClass,
      selected: { id: selected.selected.id, kind: selected.selected.kind },
      alternatives: selected.alternatives.map((option) => ({ id: option.id, kind: option.kind })),
      productionStrategy: input.productionFailure.strategy,
      semanticLoopCount: loopCount
    };
    return { ...body, recommendationDigest: sha256(canonicalJson(body)) };
  }
}

export function validateRecoveryShadowRecommendation(
  input: unknown,
  expected: { taskId?: string; planVersion?: number; authorityGeneration?: number | null } = {}
): TaskRecoveryShadowRecommendation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Recovery shadow recommendation is invalid.');
  const value = structuredClone(input) as TaskRecoveryShadowRecommendation;
  exactKeys(value as unknown as Record<string, unknown>, [
    'schemaVersion', 'mode', 'policyVersion', 'taskId', 'goalKind', 'planId', 'planVersion', 'planDigest',
    'failedNodeId', 'actionId', 'attempt', 'observationDigest', 'verificationResultDigest',
    'authoritySnapshotDigest', 'authorityGeneration', 'inputStateDigest', 'failureClass', 'selected',
    'alternatives', 'productionStrategy', 'semanticLoopCount', 'recommendationDigest'
  ], 'recommendation');
  if (value.schemaVersion !== 1 || value.mode !== 'SHADOW' || value.policyVersion !== POLICY_VERSION) throw new Error('Recovery shadow schema is invalid.');
  for (const [label, candidate, max] of [
    ['taskId', value.taskId, 512], ['goalKind', value.goalKind, 256], ['planId', value.planId, 256],
    ['failedNodeId', value.failedNodeId, 256], ['actionId', value.actionId, 512], ['failureClass', value.failureClass, 128]
  ] as const) bounded(candidate, max, label);
  if (!Number.isSafeInteger(value.planVersion) || value.planVersion < 1) throw new Error('Recovery shadow planVersion is invalid.');
  if (!Number.isSafeInteger(value.attempt) || value.attempt < 1) throw new Error('Recovery shadow attempt is invalid.');
  if (!Number.isSafeInteger(value.semanticLoopCount) || value.semanticLoopCount < 0) throw new Error('Recovery shadow loop count is invalid.');
  if (value.authorityGeneration !== null && (!Number.isSafeInteger(value.authorityGeneration) || value.authorityGeneration < 1)) throw new Error('Recovery shadow authority generation is invalid.');
  for (const [label, digest] of [
    ['planDigest', value.planDigest], ['observationDigest', value.observationDigest],
    ['verificationResultDigest', value.verificationResultDigest], ['authoritySnapshotDigest', value.authoritySnapshotDigest],
    ['inputStateDigest', value.inputStateDigest], ['recommendationDigest', value.recommendationDigest]
  ] as const) sha256Digest(digest, label);
  if (!FAILURE_CLASSES.has(value.failureClass as FailureClass)) throw new Error('Recovery shadow failure class is invalid.');
  validateSelection(value.selected);
  if (!Array.isArray(value.alternatives) || value.alternatives.length > 100) throw new Error('Recovery shadow alternatives are invalid.');
  value.alternatives.forEach(validateSelection);
  if (new Set([value.selected.id, ...value.alternatives.map((item) => item.id)]).size !== value.alternatives.length + 1) throw new Error('Recovery shadow option identities must be unique.');
  if (!['block','cancel','reobserve','repair','replan','reconcile','retry','fail'].includes(value.productionStrategy)) throw new Error('Recovery shadow production strategy is invalid.');
  const { recommendationDigest, ...body } = value;
  if (sha256(canonicalJson(body)) !== recommendationDigest) throw new Error('Recovery shadow recommendation digest mismatch.');
  if (expected.taskId !== undefined && value.taskId !== expected.taskId) throw new Error('Recovery shadow task replay detected.');
  if (expected.planVersion !== undefined && value.planVersion !== expected.planVersion) throw new Error('Recovery shadow plan-version replay detected.');
  if (expected.authorityGeneration !== undefined && value.authorityGeneration !== expected.authorityGeneration) throw new Error('Recovery shadow authority-generation replay detected.');
  return value;
}

function adaptiveFailureClass(input: Parameters<TaskRecoveryShadowAdvisor['recommend']>[0]): FailureClass {
  if (input.productionFailure.class === 'approval' || input.productionFailure.class === 'policy') return 'AUTHORITY_DENIED';
  if (input.sideEffectState === 'uncertain') return 'SIDE_EFFECT_UNCERTAIN';
  const shadow = input.outcomeAssessment?.failure?.primaryClass;
  if (shadow && FAILURE_CLASSES.has(shadow as FailureClass)) return shadow as FailureClass;
  if (input.productionFailure.class === 'stale-state') return 'TARGET_STALE';
  if (input.productionFailure.class === 'target-drift') return 'TARGET_AMBIGUOUS';
  if (input.productionFailure.class === 'transient') return 'PROVIDER_TRANSIENT';
  if (input.productionFailure.class === 'postcondition') return 'VERIFICATION_INSUFFICIENT';
  return 'UNKNOWN';
}

function recoveryOptions(): RecoveryOption[] {
  return [
    option('reobserve', 'REOBSERVE', 0.95, 0.75, 1, 0.01, ['TARGET_STALE','TARGET_AMBIGUOUS','PERCEPTION_INCOMPLETE','UNKNOWN']),
    option('reground', 'REGROUND', 0.85, 0.7, 2, 0.02, ['TARGET_AMBIGUOUS','GEOMETRY_INVALID','PERCEPTION_INCOMPLETE']),
    option('local-repair', 'REPAIR', 0.7, 0.8, 2, 0.08, ['ACTION_CONTRACT_REJECTED','ACTION_NO_EFFECT','TARGET_STALE']),
    option('alternate-branch', 'REPLAN', 0.55, 0.65, 3, 0.08, ['PLANNER_STRATEGY_WRONG','MODEL_REASONING_WRONG','GOAL_PROGRESS_FALSE_POSITIVE','ACTION_NO_EFFECT']),
    option('reconcile', 'RECONCILE', 1, 0.9, 2, 0.01, ['SIDE_EFFECT_UNCERTAIN','STATE_CHANGED_EXTERNALLY']),
    option('wait-for-provider', 'WAIT', 0.55, 0.6, 1, 0, ['PROVIDER_TRANSIENT','RESOURCE_CONTENTION']),
    option('verify-again', 'VERIFY', 0.8, 0.7, 1, 0, ['VERIFICATION_INSUFFICIENT']),
    option('unresolved-fail-safe', 'FAIL_SAFE', 0, 1, 0, 0, ['AUTHORITY_DENIED','BUDGET_EXHAUSTED','UNKNOWN'])
  ];
}

function option(id: string, kind: RecoveryKind, information: number, success: number, cost: number, risk: number, resolvesHypotheses: FailureClass[]): RecoveryOption {
  return { id, kind, description: `Non-executable ${kind.toLowerCase()} recommendation.`, expectedInformationGain: information, expectedSuccess: success, expectedCost: cost, risk, resolvesHypotheses };
}

function planIdentity(input: Parameters<TaskRecoveryShadowAdvisor['recommend']>[0]): { id: string; version: number; digest: string } {
  const raw = input.task.execution?.plannerState.durablePlan;
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  const version = Number.isSafeInteger(record?.revision) && Number(record?.revision) >= 1 ? Number(record!.revision) : 1;
  const id = record ? sha256(`${input.task.id}\0durable-plan`) : sha256(`${input.task.id}\0${input.task.execution?.plannerId ?? 'planner'}`);
  const digest = sha256(canonicalJson(record ?? {
    plannerId: input.task.execution?.plannerId ?? 'unknown',
    goalKind: input.task.execution?.goalKind ?? input.goal.kind,
    plannerState: input.task.execution?.plannerState ?? {}
  }));
  return { id, version, digest };
}

function semanticLoopCount(evidence: Parameters<TaskRecoveryShadowAdvisor['recommend']>[0]['task']['evidence'], nodeId: string, failureClass: FailureClass): number {
  return evidence.filter((item) => item.kind === 'adaptive_recovery_shadow'
    && item.data?.failedNodeId === nodeId && item.data?.failureClass === failureClass).length;
}

function remainingBudget(maxSteps = 1, usedSteps = 0): number {
  return Math.max(0, maxSteps - usedSteps);
}

function validateSelection(value: { id: string; kind: RecoveryKind }): void {
  if (!value || typeof value !== 'object') throw new Error('Recovery shadow selection is invalid.');
  exactKeys(value as unknown as Record<string, unknown>, ['id', 'kind'], 'selection');
  bounded(value.id, 256, 'selection id');
  if (!RECOVERY_KINDS.has(value.kind)) throw new Error('Recovery shadow selection kind is invalid.');
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) throw new Error(`Recovery shadow ${label} contains unsupported fields.`);
}

function bounded(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new Error(`${label} is invalid.`);
  return value;
}

function sha256Digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be SHA-256.`);
  return value;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
