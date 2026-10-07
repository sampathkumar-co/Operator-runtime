import crypto from 'node:crypto';
import { selectStrategy, type StrategyCandidate } from '../../packages/adaptive-intelligence/src/index.ts';
import { canonicalJson } from './action-identity.ts';
import type {
  TaskStrategyShadowAdvisor,
  TaskStrategyShadowAssessment,
  TaskStrategyShadowKind
} from './task-orchestrator.ts';

const POLICY_VERSION = 'adaptive-strategy-shadow-v1';
const STRATEGY_KINDS = new Set<TaskStrategyShadowKind>([
  'CONTINUE_CURRENT_BRANCH',
  'OBSERVE_THEN_CONTINUE',
  'LOCAL_REPAIR',
  'ALTERNATIVE_BRANCH',
  'GLOBAL_REPLAN',
  'RECONCILE',
  'VERIFY',
  'WAIT',
  'STOP_UNRESOLVED'
]);

/**
 * Sixth progressive activation stage.
 *
 * This advisor ranks strategy identities only. It cannot provide executable
 * inputs, mutate a plan, dispatch an action, alter routing, or widen authority.
 */
export class AdaptiveStrategyShadowAdvisor implements TaskStrategyShadowAdvisor {
  assess(input: Parameters<TaskStrategyShadowAdvisor['assess']>[0]): TaskStrategyShadowAssessment | undefined {
    if (!input.permissions.allowedCapabilities.includes(input.decision.capability)) return undefined;
    if (!riskWithinPermission(input.risk, input.permissions.maxRisk)) return undefined;

    const plan = planIdentity(input);
    const authoritySnapshotDigest = sha256(canonicalJson({
      allowedCapabilities: [...new Set(input.permissions.allowedCapabilities)].sort(),
      allowedRoots: [...new Set(input.permissions.allowedRoots)].sort(),
      maxRisk: input.permissions.maxRisk ?? null,
      allowExternalWrites: input.permissions.allowExternalWrites === true,
      allowSystemChanges: input.permissions.allowSystemChanges === true,
      allowDestructive: input.permissions.allowDestructive === true,
      enterprisePolicyDigest: input.permissions.enterprisePolicyDigest ?? null,
      enterprisePolicyGeneration: input.permissions.enterprisePolicyGeneration ?? null,
      capability: input.decision.capability,
      risk: input.risk
    }));
    const observationDigest = sha256(canonicalJson(input.observation));
    const verificationDigest = sha256(canonicalJson({
      resultOk: input.result.ok,
      provider: input.result.provider,
      capability: input.result.capability,
      sideEffectState: input.sideEffectState,
      executionPhase: input.executionPhase,
      progress: input.outcomeAssessment?.progress ?? null,
      evidenceRefs: input.observation.evidenceRefs
    }));

    const loopCount = semanticLoopCount(input.task.evidence, plan.digest, input.decision.key);
    const productionStrategy = productionStrategyIdentity(input);
    const hardStop = input.productionFailure?.class === 'approval'
      || input.productionFailure?.class === 'policy'
      || input.observation.epistemicStatus === 'UNAUTHORIZED'
      || ((input.risk === 'destructive' || input.risk === 'system') && !input.result.ok);
    const uncertainMutation = input.risk !== 'read' && input.sideEffectState === 'uncertain';
    const knowledgeUnresolved = input.observation.epistemicStatus !== 'KNOWN';

    let candidates = strategyCandidates(input, loopCount);
    if (hardStop) candidates = candidates.filter((candidate) => candidate.id === 'STOP_UNRESOLVED');
    else if (uncertainMutation) candidates = candidates.filter((candidate) =>
      candidate.id === 'RECONCILE' || candidate.id === 'STOP_UNRESOLVED');
    else if (knowledgeUnresolved) candidates = candidates.filter((candidate) =>
      candidate.id === 'OBSERVE_THEN_CONTINUE' || candidate.id === 'STOP_UNRESOLVED');
    else if (loopCount >= 3) candidates = candidates.filter((candidate) =>
      candidate.id === 'GLOBAL_REPLAN' || candidate.id === 'STOP_UNRESOLVED');

    if (candidates.length === 0) return undefined;

    const selected = selectStrategy({
      candidates,
      remainingCostBudget: Math.max(0, (input.task.execution?.maxSteps ?? 1) - (input.task.execution?.stepCount ?? 0)),
      explorationWeight: 0
    });
    const ranked = selected.ranked.map((candidate) => ({
      kind: candidate.id as TaskStrategyShadowKind,
      utility: candidate.utility,
      expectedSuccess: candidate.expectedSuccess,
      expectedCost: candidate.expectedCost,
      uncertainty: candidate.uncertainty,
      verificationStrength: candidate.verificationStrength,
      penalties: [...candidate.penalties]
    }));

    const inputStateDigest = sha256(canonicalJson({
      taskId: input.task.id,
      actionId: input.actionId,
      planId: plan.id,
      planVersion: plan.version,
      planDigest: plan.digest,
      decisionKey: input.decision.key,
      capability: input.decision.capability,
      authoritySnapshotDigest,
      observationDigest,
      verificationDigest,
      productionStrategy,
      recovery: input.recoveryRecommendation?.selected.kind ?? null,
      modality: input.modalityAssessment?.recommendedModality ?? null,
      outcome: input.outcomeAssessment ?? null,
      loopCount,
      uncertainMutation,
      hardStop
    }));

    const body: Omit<TaskStrategyShadowAssessment, 'assessmentDigest'> = {
      schemaVersion: 1,
      mode: 'SHADOW',
      policyVersion: POLICY_VERSION,
      taskId: input.task.id,
      actionId: input.actionId,
      decisionKey: input.decision.key,
      planId: plan.id,
      planVersion: plan.version,
      planDigest: plan.digest,
      authorityGeneration: input.permissions.enterprisePolicyGeneration ?? null,
      authoritySnapshotDigest,
      observationDigest,
      verificationDigest,
      inputStateDigest,
      recommendedStrategy: selected.selected.id as TaskStrategyShadowKind,
      productionStrategy,
      candidates: ranked,
      semanticLoopCount: loopCount,
      controlAllowed: false
    };
    return { ...body, assessmentDigest: sha256(canonicalJson(body)) };
  }
}

export function validateStrategyShadowAssessment(
  input: unknown,
  expected: { taskId?: string; planVersion?: number; authorityGeneration?: number | null } = {}
): TaskStrategyShadowAssessment {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Strategy shadow assessment is invalid.');
  const value = structuredClone(input) as TaskStrategyShadowAssessment;
  exactKeys(value as unknown as Record<string, unknown>, [
    'schemaVersion', 'mode', 'policyVersion', 'taskId', 'actionId', 'decisionKey', 'planId', 'planVersion', 'planDigest',
    'authorityGeneration', 'authoritySnapshotDigest', 'observationDigest', 'verificationDigest',
    'inputStateDigest', 'recommendedStrategy', 'productionStrategy', 'candidates',
    'semanticLoopCount', 'controlAllowed', 'assessmentDigest'
  ]);
  if (value.schemaVersion !== 1 || value.mode !== 'SHADOW' || value.policyVersion !== POLICY_VERSION) {
    throw new Error('Strategy shadow schema is invalid.');
  }
  bounded(value.taskId, 512, 'taskId');
  bounded(value.actionId, 512, 'actionId');
  bounded(value.decisionKey, 256, 'decisionKey');
  sha256Digest(value.planId, 'planId');
  if (!Number.isSafeInteger(value.planVersion) || value.planVersion < 1) throw new Error('Strategy shadow planVersion is invalid.');
  sha256Digest(value.planDigest, 'planDigest');
  if (value.authorityGeneration !== null && (!Number.isSafeInteger(value.authorityGeneration) || value.authorityGeneration < 1)) {
    throw new Error('Strategy shadow authority generation is invalid.');
  }
  for (const [label, digest] of [
    ['authoritySnapshotDigest', value.authoritySnapshotDigest],
    ['observationDigest', value.observationDigest],
    ['verificationDigest', value.verificationDigest],
    ['inputStateDigest', value.inputStateDigest],
    ['assessmentDigest', value.assessmentDigest]
  ] as const) sha256Digest(digest, label);
  if (!STRATEGY_KINDS.has(value.recommendedStrategy) || !STRATEGY_KINDS.has(value.productionStrategy)) {
    throw new Error('Strategy shadow strategy identity is invalid.');
  }
  if (!Array.isArray(value.candidates) || value.candidates.length < 1 || value.candidates.length > 16) {
    throw new Error('Strategy shadow candidates are invalid.');
  }
  const seen = new Set<string>();
  for (const candidate of value.candidates) {
    exactKeys(candidate as unknown as Record<string, unknown>, [
      'kind', 'utility', 'expectedSuccess', 'expectedCost', 'uncertainty', 'verificationStrength', 'penalties'
    ]);
    if (!STRATEGY_KINDS.has(candidate.kind) || seen.has(candidate.kind)) throw new Error('Strategy shadow candidate identity is invalid.');
    seen.add(candidate.kind);
    unit(candidate.expectedSuccess, 'candidate expectedSuccess');
    nonNegative(candidate.expectedCost, 'candidate expectedCost');
    unit(candidate.uncertainty, 'candidate uncertainty');
    unit(candidate.verificationStrength, 'candidate verificationStrength');
    if (typeof candidate.utility !== 'number' || !Number.isFinite(candidate.utility)) throw new Error('Strategy shadow candidate utility is invalid.');
    if (!Array.isArray(candidate.penalties) || candidate.penalties.length > 20 || candidate.penalties.some((item) => typeof item !== 'string' || item.length > 128)) {
      throw new Error('Strategy shadow candidate penalties are invalid.');
    }
  }
  if (!Number.isSafeInteger(value.semanticLoopCount) || value.semanticLoopCount < 0) throw new Error('Strategy shadow loop count is invalid.');
  if (value.controlAllowed !== false) throw new Error('Strategy shadow cannot carry control authority.');

  const { assessmentDigest, ...body } = value;
  if (sha256(canonicalJson(body)) !== assessmentDigest) throw new Error('Strategy shadow assessment digest mismatch.');
  if (expected.taskId !== undefined && value.taskId !== expected.taskId) throw new Error('Strategy shadow task replay detected.');
  if (expected.planVersion !== undefined && value.planVersion !== expected.planVersion) throw new Error('Strategy shadow plan-version replay detected.');
  if (expected.authorityGeneration !== undefined && value.authorityGeneration !== expected.authorityGeneration) {
    throw new Error('Strategy shadow authority-generation replay detected.');
  }
  return value;
}

function strategyCandidates(
  input: Parameters<TaskStrategyShadowAdvisor['assess']>[0],
  loopCount: number
): StrategyCandidate[] {
  const candidates: StrategyCandidate[] = [];
  const add = (kind: TaskStrategyShadowKind, success: number, cost: number, uncertainty: number, verification: number) => {
    candidates.push({
      id: kind,
      family: kind.toLowerCase().replaceAll('_', '-'),
      description: `Non-executable ${kind.toLowerCase()} shadow strategy.`,
      expectedSuccess: success,
      expectedCost: cost,
      uncertainty,
      verificationStrength: verification,
      repeatedEquivalentFailures: loopCount,
      requiresFacts: [`capability:${input.decision.capability}`],
      expectedEffects: [`strategy:${kind}`]
    });
  };

  const failure = input.productionFailure;
  const progress = input.outcomeAssessment?.progress.level;
  const recovery = input.recoveryRecommendation?.selected.kind;

  add('STOP_UNRESOLVED', failure?.class === 'policy' || failure?.class === 'approval' ? 1 : 0.38, 0, 0.02, 1);
  if (input.observation.epistemicStatus !== 'KNOWN' && input.observation.epistemicStatus !== 'UNAUTHORIZED') {
    add('OBSERVE_THEN_CONTINUE', 0.93, 1, 0.07, 0.96);
  }

  if (input.sideEffectState === 'uncertain') {
    add('RECONCILE', 0.94, 1, 0.08, 0.96);
    return candidates;
  }

  if (failure?.class === 'policy' || failure?.class === 'approval') return candidates;

  if (progress === 'GOAL_ACHIEVED' || input.result.ok) add('VERIFY', progress === 'GOAL_ACHIEVED' ? 0.96 : 0.82, 1, 0.05, 1);
  if (!failure && input.result.ok) add('CONTINUE_CURRENT_BRANCH', 0.84, 1, 0.12, 0.86);

  if (recovery === 'REOBSERVE' || failure?.strategy === 'reobserve') add('OBSERVE_THEN_CONTINUE', 0.88, 1, 0.08, 0.94);
  if (recovery === 'REPAIR' || failure?.strategy === 'repair') add('LOCAL_REPAIR', 0.76, 2, 0.2, 0.88);
  if (recovery === 'REPLAN' || failure?.strategy === 'replan') add('GLOBAL_REPLAN', 0.72, 3, 0.22, 0.9);
  if (recovery === 'WAIT' || failure?.strategy === 'retry') add('WAIT', 0.68, 1, 0.18, 0.88);
  if (recovery === 'VERIFY') add('VERIFY', 0.9, 1, 0.06, 1);
  if (recovery === 'RECONCILE' || failure?.strategy === 'reconcile') add('RECONCILE', 0.92, 1, 0.08, 0.97);

  if (input.intelligence.procedures.length > 1 && !failure?.class?.includes('policy')) {
    add('ALTERNATIVE_BRANCH', 0.7, 2, 0.24, 0.86);
  }
  if (loopCount >= 2) add('GLOBAL_REPLAN', 0.82, 3, 0.15, 0.92);

  if (candidates.length === 1) add('GLOBAL_REPLAN', 0.5, 3, 0.3, 0.9);
  return dedupeCandidates(candidates);
}

function dedupeCandidates(candidates: StrategyCandidate[]): StrategyCandidate[] {
  const byId = new Map<string, StrategyCandidate>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.id);
    if (!existing || candidate.expectedSuccess > existing.expectedSuccess) byId.set(candidate.id, candidate);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function productionStrategyIdentity(input: Parameters<TaskStrategyShadowAdvisor['assess']>[0]): TaskStrategyShadowKind {
  if (input.sideEffectState === 'uncertain') return 'RECONCILE';
  const strategy = input.productionFailure?.strategy;
  if (strategy === 'reobserve') return 'OBSERVE_THEN_CONTINUE';
  if (strategy === 'repair') return 'LOCAL_REPAIR';
  if (strategy === 'replan') return 'GLOBAL_REPLAN';
  if (strategy === 'reconcile') return 'RECONCILE';
  if (strategy === 'retry') return 'WAIT';
  if (strategy === 'block' || strategy === 'cancel' || strategy === 'fail') return 'STOP_UNRESOLVED';
  if (input.result.ok) return 'CONTINUE_CURRENT_BRANCH';
  return 'STOP_UNRESOLVED';
}

function planIdentity(input: Parameters<TaskStrategyShadowAdvisor['assess']>[0]): { id: string; version: number; digest: string } {
  const raw = input.task.execution?.plannerState.durablePlan;
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  const version = Number.isSafeInteger(record?.revision) && Number(record?.revision) >= 1 ? Number(record!.revision) : 1;
  const id = sha256(`${input.task.id}\0${record ? 'durable-plan' : input.task.execution?.plannerId ?? 'planner'}`);
  const digest = sha256(canonicalJson(record ?? {
    plannerId: input.task.execution?.plannerId ?? 'unknown',
    goalKind: input.task.execution?.goalKind ?? input.goal.kind,
    plannerState: input.task.execution?.plannerState ?? {}
  }));
  return { id, version, digest };
}

function semanticLoopCount(
  evidence: Parameters<TaskStrategyShadowAdvisor['assess']>[0]['task']['evidence'],
  planDigest: string,
  decisionKey: string
): number {
  return evidence.filter((item) =>
    item.kind === 'adaptive_strategy_shadow'
    && item.data?.planDigest === planDigest
    && item.data?.decisionKey === decisionKey
  ).length;
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) throw new Error('Strategy shadow contains unsupported fields.');
}

function bounded(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new Error(`${label} is invalid.`);
  return value;
}
function sha256Digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be SHA-256.`);
  return value;
}
function unit(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} is invalid.`);
  return value;
}
function nonNegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} is invalid.`);
  return value;
}
function riskWithinPermission(risk: string, maximum: string | undefined): boolean {
  const rank: Record<string, number> = { read: 0, write: 1, external: 2, system: 3, destructive: 4 };
  return (rank[risk] ?? 99) <= (rank[maximum ?? 'read'] ?? -1);
}
function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
