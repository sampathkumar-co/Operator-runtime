import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AdaptiveRecoveryShadowAdvisor,
  validateRecoveryShadowRecommendation
} from '../src/core/adaptive-recovery-shadow.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { createTask, type TaskCapsule, type TaskObservationSummaryV2 } from '../src/core/task.ts';
import { TaskStore } from '../src/core/task-store.ts';
import {
  TaskOrchestrator,
  type TaskObservation,
  type TaskPlanner,
  type TaskPlannerContext,
  type TaskRecoveryShadowAdvisor,
  type TaskRecoveryShadowRecommendation
} from '../src/core/task-orchestrator.ts';
import type { ActionResult, PermissionProfile } from '../src/core/types.ts';

type RecoveryInput = Parameters<TaskRecoveryShadowAdvisor['recommend']>[0];

function permissions(generation = 7): PermissionProfile {
  return {
    allowedCapabilities: ['file.info', 'file.write'], allowedRoots: ['C:/scope'], maxRisk: 'write',
    enterprisePolicyDigest: 'a'.repeat(64), enterprisePolicyGeneration: generation
  };
}

function observation(): TaskObservationSummaryV2 {
  return {
    schemaVersion: 2, channel: 'semantic', domain: 'filesystem', provider: 'test-provider',
    capability: 'file.write', entityId: 'filesystem:item', observedAt: '2026-10-06T00:00:00.000Z',
    stateVersion: 'b'.repeat(64), importantState: { exists: true }, epistemicStatus: 'KNOWN',
    epistemicReason: 'verified', ambiguous: false, confidence: 1, evidenceRefs: ['c'.repeat(64)]
  };
}

function task(): TaskCapsule {
  const value = createTask({
    userObjective: 'Safely change one file', interpretedObjective: 'Safely change one file',
    authorizedScope: ['C:/scope'], prohibitedScope: ['C:/scope/forbidden'], successConditions: ['verified']
  });
  value.execution = {
    schemaVersion: 1, plannerId: 'test.recovery', goalKind: 'controlled-file-change',
    plannerState: {
      durablePlan: { revision: 4, facts: [{ id: 'allowed', status: 'ACTIVE' }, { id: 'forbidden', status: 'FORBIDDEN' }] }
    },
    maxSteps: 10, maxAttemptsPerStep: 3, timeoutMs: 10_000, stepCount: 1,
    plannerIterations: 1, progressExtensions: 0, progressProofDigests: [],
    preDispatchReobserves: 0, dispatchedActions: 1, records: []
  };
  return value;
}

function input(overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  const result: ActionResult = {
    ok: false, capability: 'file.write', provider: 'test-provider', evidence: [], durationMs: 2,
    error: {
      code: 'PROVIDER_CONNECTION_LOST', message: 'Connection lost after dispatch.', retryable: true,
      sideEffectState: 'uncertain', executionPhase: 'dispatched'
    }
  };
  return {
    task: task(),
    goal: { kind: 'controlled-file-change', root: 'C:/scope', path: 'item', content: 'new' },
    decision: { type: 'step', key: 'write', title: 'Write', capability: 'file.write', input: { path: 'item', content: 'new' } },
    actionId: 'action-recovery-shadow', failedNodeId: 'node-write', attempt: 1, risk: 'write',
    permissions: permissions(), result, observation: observation(), sideEffectState: 'uncertain',
    executionPhase: 'dispatched',
    productionFailure: { class: 'transient', strategy: 'reconcile', retryable: false, code: 'PROVIDER_CONNECTION_LOST' },
    outcomeAssessment: {
      mode: 'SHADOW', policyVersion: 'test-outcome-v1',
      progress: { level: 'NONE', confidence: 1, creditedSignals: [], rejectedSignals: [], verificationRequired: true },
      failure: { primaryClass: 'SIDE_EFFECT_UNCERTAIN', probability: 1, alternatives: [], entropy: 0, evidenceCoverage: 1 },
      decisionDigest: 'd'.repeat(64), authoritySnapshotDigest: 'e'.repeat(64), inputStateDigest: 'f'.repeat(64)
    },
    ...overrides
  };
}

test('uncertain mutation recommends reconciliation and never blind replay', () => {
  const recommendation = new AdaptiveRecoveryShadowAdvisor().recommend(input());
  assert.equal(recommendation.selected.kind, 'RECONCILE');
  assert.notEqual(recommendation.selected.kind, 'REPAIR');
  assert.doesNotMatch(JSON.stringify(recommendation), /content|PROVIDER_CONNECTION_LOST|Connection lost/);
});

test('stale target recommends a fresh observation', () => {
  const candidate = input({
    sideEffectState: 'none', executionPhase: 'pre_dispatch',
    productionFailure: { class: 'stale-state', strategy: 'reobserve', retryable: true, code: 'TASK_STATE_STALE' },
    outcomeAssessment: undefined
  });
  assert.equal(new AdaptiveRecoveryShadowAdvisor().recommend(candidate).selected.kind, 'REOBSERVE');
});

test('authority denial fails safe and cannot become a modality bypass', () => {
  const candidate = input({
    sideEffectState: 'none', executionPhase: 'pre_dispatch', risk: 'read',
    productionFailure: { class: 'policy', strategy: 'block', retryable: false, code: 'POLICY_DENIED' },
    outcomeAssessment: {
      mode: 'SHADOW', policyVersion: 'adversarial-outcome',
      progress: { level: 'NONE', confidence: 1, creditedSignals: [], rejectedSignals: [], verificationRequired: true },
      failure: { primaryClass: 'TARGET_AMBIGUOUS', probability: 1, alternatives: [], entropy: 0, evidenceCoverage: 1 },
      decisionDigest: 'd'.repeat(64), authoritySnapshotDigest: 'e'.repeat(64), inputStateDigest: 'f'.repeat(64)
    }
  });
  const recommendation = new AdaptiveRecoveryShadowAdvisor().recommend(candidate);
  assert.equal(recommendation.selected.kind, 'FAIL_SAFE');
  assert.notEqual(recommendation.selected.kind, 'REGROUND');
});

test('irreversible failed action never recommends automatic retry or repair', () => {
  const candidate = input({
    risk: 'destructive', sideEffectState: 'known', executionPhase: 'effect_observed',
    productionFailure: { class: 'permanent', strategy: 'fail', retryable: false, code: 'DELETE_FAILED' },
    outcomeAssessment: undefined
  });
  assert.equal(new AdaptiveRecoveryShadowAdvisor().recommend(candidate).selected.kind, 'FAIL_SAFE');
});

test('recommendation is bound to exact plan version and policy generation', () => {
  const recommendation = new AdaptiveRecoveryShadowAdvisor().recommend(input());
  assert.equal(validateRecoveryShadowRecommendation(recommendation, {
    taskId: recommendation.taskId, planVersion: 4, authorityGeneration: 7
  }).recommendationDigest, recommendation.recommendationDigest);
  assert.throws(() => validateRecoveryShadowRecommendation(recommendation, { planVersion: 5 }), /plan-version replay/);
  assert.throws(() => validateRecoveryShadowRecommendation(recommendation, { authorityGeneration: 8 }), /authority-generation replay/);
});

test('branch repair is identity-only and cannot reactivate forbidden plan facts', () => {
  const candidate = input({
    sideEffectState: 'none', executionPhase: 'effect_observed',
    productionFailure: { class: 'postcondition', strategy: 'repair', retryable: true, code: 'NO_EFFECT' },
    outcomeAssessment: {
      mode: 'SHADOW', policyVersion: 'test-outcome-v1',
      progress: { level: 'NONE', confidence: 1, creditedSignals: [], rejectedSignals: [], verificationRequired: true },
      failure: { primaryClass: 'ACTION_NO_EFFECT', probability: 1, alternatives: [], entropy: 0, evidenceCoverage: 1 },
      decisionDigest: 'd'.repeat(64), authoritySnapshotDigest: 'e'.repeat(64), inputStateDigest: 'f'.repeat(64)
    }
  });
  const before = structuredClone(candidate.task.execution!.plannerState);
  const recommendation = new AdaptiveRecoveryShadowAdvisor().recommend(candidate);
  assert.equal(recommendation.selected.kind, 'REPAIR');
  assert.deepEqual(candidate.task.execution!.plannerState, before);
  assert.equal('operations' in recommendation, false);
  assert.equal('facts' in recommendation, false);
  assert.equal('input' in recommendation.selected, false);
  const smuggled = structuredClone(recommendation) as TaskRecoveryShadowRecommendation & { input?: unknown };
  smuggled.input = { forbiddenFact: 'ACTIVE' };
  assert.throws(() => validateRecoveryShadowRecommendation(smuggled), /unsupported fields/);
});

test('semantic repair loop is bounded and fails safe on the third identical recommendation', () => {
  const advisor = new AdaptiveRecoveryShadowAdvisor();
  const candidate = input({ sideEffectState: 'none', executionPhase: 'effect_observed', outcomeAssessment: undefined });
  const first = advisor.recommend(candidate);
  candidate.task.evidence.push(
    { kind: 'adaptive_recovery_shadow', status: 'info', message: 'prior', timestamp: new Date().toISOString(), data: first },
    { kind: 'adaptive_recovery_shadow', status: 'info', message: 'prior', timestamp: new Date().toISOString(), data: first }
  );
  const stopped = advisor.recommend(candidate);
  assert.equal(stopped.semanticLoopCount, 2);
  assert.equal(stopped.selected.kind, 'FAIL_SAFE');
});

test('durable restart preserves exact lineage and rejects corrupted recovery evidence', async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'operator-recovery-shadow-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new TaskStore(directory);
  const value = task();
  delete value.execution!.plannerState.durablePlan;
  const recommendation = new AdaptiveRecoveryShadowAdvisor().recommend(input({ task: value }));
  value.evidence.push({
    kind: 'adaptive_recovery_shadow', status: 'info', message: 'shadow', timestamp: new Date().toISOString(), data: recommendation
  });
  await store.create(value);
  const restarted = await new TaskStore(directory).get(value.id);
  assert.deepEqual(restarted.evidence.at(-1)?.data, recommendation);

  const corrupted = structuredClone(restarted);
  const data = corrupted.evidence.at(-1)!.data as unknown as TaskRecoveryShadowRecommendation;
  data.recommendationDigest = '0'.repeat(64);
  await assert.rejects(() => store.put(corrupted), (error: any) => error?.code === 'TASK_STATE_CORRUPT');
});

class OneWritePlanner implements TaskPlanner {
  readonly id = 'test.recovery-shadow-integration';
  supports(): boolean { return true; }
  next() {
    return { type: 'step' as const, key: 'write', title: 'Write', capability: 'file.write', input: { path: 'item', content: 'new' } };
  }
  accept(_context: TaskPlannerContext, _step: any, _observation: TaskObservation): void {}
}

test('shadow disagreement cannot replay an uncertain production mutation', async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'operator-recovery-control-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let executions = 0;
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime(), store: new TaskStore(directory), planners: [new OneWritePlanner()],
    permissions: permissions(), recoveryShadow: new AdaptiveRecoveryShadowAdvisor(),
    executeAction: async (): Promise<ActionResult> => {
      executions += 1;
      return {
        ok: false, capability: 'file.write', provider: 'control-provider', evidence: [], durationMs: 1,
        error: {
          code: 'PROVIDER_CONNECTION_LOST', message: 'lost after dispatch', retryable: true,
          sideEffectState: 'uncertain', executionPhase: 'dispatched'
        }
      };
    }
  });
  const submitted = await orchestrator.submit({
    objective: 'Change once', authorizedScope: ['C:/scope'], successConditions: ['verified'],
    goal: { kind: 'controlled-file-change', root: 'C:/scope', path: 'item', content: 'new' }
  });
  const completed = await orchestrator.run(submitted.id);
  assert.equal(completed.state, 'BLOCKED');
  assert.equal(executions, 1);
  assert.equal(completed.evidence.find((item) => item.kind === 'adaptive_recovery_shadow')?.data?.selected?.kind, 'RECONCILE');
});

test('recovery shadow failure is fail-open and cannot replace production control', async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'operator-recovery-unavailable-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime(), store: new TaskStore(directory), planners: [new OneWritePlanner()],
    permissions: permissions(), recoveryShadow: { recommend() { throw new Error('shadow unavailable'); } },
    executeAction: async (): Promise<ActionResult> => ({
      ok: false, capability: 'file.write', provider: 'control-provider', evidence: [], durationMs: 1,
      error: { code: 'POLICY_DENIED', message: 'denied', retryable: false, sideEffectState: 'none', executionPhase: 'pre_dispatch' }
    })
  });
  const submitted = await orchestrator.submit({
    objective: 'Change once', authorizedScope: ['C:/scope'], successConditions: ['verified'],
    goal: { kind: 'controlled-file-change', root: 'C:/scope', path: 'item', content: 'new' }
  });
  const completed = await orchestrator.run(submitted.id);
  assert.notEqual(completed.state, 'VERIFIED');
  assert.match(completed.evidence.find((item) => item.kind === 'adaptive_recovery_shadow_unavailable')?.message ?? '', /unavailable/);
});
