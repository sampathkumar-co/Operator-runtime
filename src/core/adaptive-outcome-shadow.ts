import crypto from 'node:crypto';
import {
  assessProgress,
  attributeFailure,
  CausalGraph,
  DecisionTraceLog,
  type ActionDescriptor,
  type ActionOutcome,
  type EvidenceRef,
  type StateFact,
  type StateSnapshot
} from '../../packages/adaptive-intelligence/src/index.ts';
import { canonicalJson } from './action-identity.ts';
import type {
  TaskOutcomeShadowAdvisor,
  TaskOutcomeShadowAssessment
} from './task-orchestrator.ts';
import type { ActionRisk } from './types.ts';

const POLICY_VERSION = 'adaptive-outcome-shadow-v1';

/** Second progressive activation stage. It emits advisory evidence and has no control-plane output. */
export class AdaptiveOutcomeShadowAdvisor implements TaskOutcomeShadowAdvisor {
  #clock: () => Date;

  constructor(options: { clock?: () => Date } = {}) {
    this.#clock = options.clock ?? (() => new Date());
  }

  analyze(input: Parameters<TaskOutcomeShadowAdvisor['analyze']>[0]): TaskOutcomeShadowAssessment {
    const evidence = evidenceRefs(input);
    const after = snapshotFromObservation(input.observation, evidence, 'after');
    const comparable = input.previousObservation?.entityId === input.observation.entityId
      ? input.previousObservation
      : undefined;
    const before = comparable
      ? snapshotFromObservation(comparable, evidenceRefsForObservation(comparable), 'before')
      : { ...after, id: `${input.actionId}:before` };
    const output = record(input.result.output);
    const stateDelta = record(output.stateDelta);
    const progressSignals = stateDelta.progress === true ? ['provider-state-delta'] : [];
    const action: ActionDescriptor = {
      id: input.actionId,
      family: input.decision.key,
      capability: input.decision.capability,
      risk: adaptiveRisk(input.risk),
      semanticTarget: input.observation.entityId,
      expectedEffects: []
    };
    const outcome: ActionOutcome = {
      ok: input.result.ok,
      provider: input.result.provider,
      durationMs: input.result.durationMs,
      ...(input.result.error?.code ? { errorCode: input.result.error.code } : {}),
      sideEffectState: input.sideEffectState,
      executionPhase: adaptiveExecutionPhase(input.executionPhase),
      evidence
    };
    const transition = new CausalGraph({ maxTransitions: 1, clock: () => new Date(input.observation.observedAt) }).record({
      before,
      action,
      outcome,
      after,
      progressSignals
    });
    const progress = assessProgress({
      goal: {
        id: goalId(input.task.id, input.goal.kind),
        kind: input.goal.kind,
        objective: input.task.interpretedObjective,
        successFactKeys: [`goal:${input.goal.kind}:verified`]
      },
      transition,
      beliefs: []
    });
    const shouldAttributeFailure = !input.result.ok || stateDelta.progress === false;
    const failure = shouldAttributeFailure
      ? attributeFailure({
          transition,
          authorityDenied: input.productionFailure?.class === 'policy' || input.productionFailure?.class === 'approval',
          resourceBusy: input.productionFailure?.code === 'RESOURCE_BUSY',
          providerTransient: input.productionFailure?.class === 'transient',
          verificationSufficient: input.productionFailure?.class === 'postcondition' ? false : undefined,
          plannerExpectedProgress: stateDelta.progress === false
        })
      : undefined;
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
      taskId: input.task.id,
      actionId: input.actionId,
      goalKind: input.goal.kind,
      capability: input.decision.capability,
      ok: input.result.ok,
      errorCode: input.result.error?.code ?? null,
      observationStateVersion: input.observation.stateVersion,
      previousStateVersion: comparable?.stateVersion ?? null,
      explicitProgress: stateDelta.progress === true ? true : stateDelta.progress === false ? false : null,
      sideEffectState: input.sideEffectState,
      executionPhase: input.executionPhase
    }));
    const trace = new DecisionTraceLog({ maxRecords: 1, clock: this.#clock }).append({
      mode: 'SHADOW',
      kind: 'PROGRESS',
      runId: input.task.id,
      taskId: input.task.id,
      goalId: goalId(input.task.id, input.goal.kind),
      policyVersion: POLICY_VERSION,
      decisionPointId: input.actionId,
      selectedId: progress.level,
      alternatives: failure ? [failure.primary.class, ...failure.alternatives.map((item) => item.class)] : [],
      reason: 'Outcome reasoning used normalized machine evidence in shadow mode; production progress and recovery logic remains authoritative.',
      evidence,
      authoritySnapshotDigest,
      inputStateDigest
    });
    return {
      mode: 'SHADOW',
      policyVersion: POLICY_VERSION,
      progress: {
        level: progress.level,
        confidence: progress.confidence,
        creditedSignals: progress.creditedSignals,
        rejectedSignals: progress.rejectedSignals,
        verificationRequired: progress.verificationRequired
      },
      ...(failure ? {
        failure: {
          primaryClass: failure.primary.class,
          probability: failure.primary.probability,
          alternatives: failure.alternatives.map((item) => ({ class: item.class, probability: item.probability })),
          entropy: failure.entropy,
          evidenceCoverage: failure.evidenceCoverage
        }
      } : {}),
      decisionDigest: trace.decisionDigest,
      authoritySnapshotDigest,
      inputStateDigest
    };
  }
}

function snapshotFromObservation(
  observation: Parameters<TaskOutcomeShadowAdvisor['analyze']>[0]['observation'],
  evidence: EvidenceRef[],
  suffix: string
): StateSnapshot {
  const fact: StateFact = {
    key: `observation:${observation.entityId}:state`,
    valueDigest: observation.stateVersion,
    confidence: observation.confidence,
    evidence
  };
  return {
    id: `${observation.entityId}:${suffix}`,
    observedAt: observation.observedAt,
    scopeKey: observation.entityId,
    stateVersion: observation.stateVersion,
    facts: [fact]
  };
}

function evidenceRefs(input: Parameters<TaskOutcomeShadowAdvisor['analyze']>[0]): EvidenceRef[] {
  return input.observation.evidenceRefs.slice(0, 100).map((digest) => ({
    digest,
    source: 'operator-runtime',
    observedAt: input.observation.observedAt,
    channel: input.observation.domain,
    scope: input.observation.entityId,
    independenceKey: `${input.result.provider}:${input.result.capability}`
  }));
}

function evidenceRefsForObservation(
  observation: Parameters<TaskOutcomeShadowAdvisor['analyze']>[0]['observation']
): EvidenceRef[] {
  return observation.evidenceRefs.slice(0, 100).map((digest) => ({
    digest,
    source: 'operator-runtime',
    observedAt: observation.observedAt,
    channel: observation.domain,
    scope: observation.entityId,
    independenceKey: `${observation.provider}:${observation.capability}`
  }));
}

function adaptiveRisk(risk: ActionRisk): ActionDescriptor['risk'] {
  if (risk === 'read' || risk === 'write') return risk;
  if (risk === 'external') return 'network';
  if (risk === 'system') return 'execute';
  return 'unknown';
}

function adaptiveExecutionPhase(phase: Parameters<TaskOutcomeShadowAdvisor['analyze']>[0]['executionPhase']): ActionOutcome['executionPhase'] {
  if (phase === 'pre_dispatch' || phase === 'effect_observed') return phase;
  if (phase === 'dispatched') return 'dispatching';
  return 'effect_observed';
}

function goalId(taskId: string, kind: string): string {
  return sha256(`${taskId}\0${kind}`).slice(0, 64);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
