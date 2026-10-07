import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAdaptiveShadowStack } from '../src/core/adaptive-shadow-evaluation.ts';
import { AdaptiveRecoveryShadowAdvisor } from '../src/core/adaptive-recovery-shadow.ts';
import { AdaptiveStrategyShadowAdvisor } from '../src/core/adaptive-strategy-shadow.ts';
import { createTask, type TaskCapsule, type TaskObservationSummaryV2 } from '../src/core/task.ts';
import type {
  TaskIntelligenceContext,
  TaskRecoveryShadowAdvisor,
  TaskStrategyShadowAdvisor
} from '../src/core/task-orchestrator.ts';
import type { ActionResult, PermissionProfile } from '../src/core/types.ts';

const NOW = '2026-10-06T12:00:00.000Z';

function permissions(): PermissionProfile {
  return {
    allowedCapabilities: ['browser.inspect', 'browser.interact'],
    allowedRoots: ['C:/scope'],
    maxRisk: 'write',
    enterprisePolicyDigest: 'a'.repeat(64),
    enterprisePolicyGeneration: 7
  };
}

function intelligence(): TaskIntelligenceContext {
  return {
    retrievedAt: NOW,
    scopeKey: 'scope',
    world: [],
    procedures: [{ id: 'p1', confidence: .9, capabilities: ['browser.inspect'], verifiedRuns: 3, failedRuns: 0, verificationDigest: '1'.repeat(64) }],
    perception: [{ nodeId: 'dom', confidence: 1, channels: ['dom'] }],
    strategies: []
  };
}

function observation(): TaskObservationSummaryV2 {
  return {
    schemaVersion: 2, channel: 'semantic', domain: 'browser', provider: 'browser.cdp',
    capability: 'browser.interact', entityId: 'browser:tab', observedAt: NOW,
    stateVersion: 'b'.repeat(64), importantState: { url: 'https://example.test/' },
    epistemicStatus: 'KNOWN', epistemicReason: 'verified', ambiguous: false, confidence: 1,
    evidenceRefs: ['c'.repeat(64)]
  };
}

function baseTask(): TaskCapsule {
  const task = createTask({
    userObjective: 'Evaluate shadow stack',
    interpretedObjective: 'Evaluate shadow stack',
    authorizedScope: ['C:/scope'],
    prohibitedScope: [],
    successConditions: ['verified']
  });
  task.execution = {
    schemaVersion: 1,
    plannerId: 'test.shadow-evaluation',
    goalKind: 'browser-navigation',
    plannerState: { durablePlan: { revision: 2, facts: [{ id: 'known', status: 'ACTIVE' }] } },
    maxSteps: 10, maxAttemptsPerStep: 2, timeoutMs: 10_000, stepCount: 1,
    plannerIterations: 1, progressExtensions: 0, progressProofDigests: [],
    preDispatchReobserves: 0, dispatchedActions: 1, records: []
  };
  return task;
}

function buildSafeTask(): TaskCapsule {
  const task = baseTask();
  const result: ActionResult = {
    ok: false, capability: 'browser.interact', provider: 'browser.cdp', evidence: [], durationMs: 4,
    error: { code: 'CONNECTION_LOST', message: 'lost', retryable: true, sideEffectState: 'uncertain', executionPhase: 'dispatched' }
  };
  const recoveryInput: Parameters<TaskRecoveryShadowAdvisor['recommend']>[0] = {
    task: structuredClone(task),
    goal: { kind: 'browser-navigation', url: 'https://example.test/' },
    decision: { type: 'step', key: 'interact', title: 'Interact', capability: 'browser.interact', input: {} },
    actionId: 'shadow-eval-action',
    failedNodeId: task.nodes[0]?.id ?? task.id,
    attempt: 1,
    risk: 'write',
    permissions: permissions(),
    result,
    observation: observation(),
    sideEffectState: 'uncertain',
    executionPhase: 'dispatched',
    productionFailure: { class: 'transient', strategy: 'reconcile', retryable: false, code: 'CONNECTION_LOST' },
    outcomeAssessment: {
      mode: 'SHADOW',
      policyVersion: 'adaptive-outcome-shadow-v1',
      progress: { level: 'NONE', confidence: 1, creditedSignals: [], rejectedSignals: [], verificationRequired: true },
      failure: { primaryClass: 'SIDE_EFFECT_UNCERTAIN', probability: 1, alternatives: [], entropy: 0, evidenceCoverage: 1 },
      decisionDigest: 'd'.repeat(64), authoritySnapshotDigest: 'e'.repeat(64), inputStateDigest: 'f'.repeat(64)
    }
  };
  const recovery = new AdaptiveRecoveryShadowAdvisor().recommend(recoveryInput);
  const modality = {
    schemaVersion: 1, mode: 'SHADOW' as const, policyVersion: 'adaptive-modality-shadow-v1',
    taskId: task.id, actionId: 'shadow-eval-action', capability: 'browser.interact',
    recommendedModality: 'DOM' as const, actualProductionModality: 'DOM' as const,
    candidates: [{ modality: 'DOM' as const, available: true, predictedSuccess: .8, predictedRisk: .25, predictedCost: 1, verificationStrength: .9, utility: .7 }],
    actualOutcome: 'UNCERTAIN' as const, verificationResult: 'FAILED' as const, recoveryCost: 2, latencyMs: 4,
    failureAttribution: 'SIDE_EFFECT_UNCERTAIN', switchAllowed: false,
    authoritySnapshotDigest: '1'.repeat(64), observationDigest: '2'.repeat(64), inputStateDigest: '3'.repeat(64),
    assessmentDigest: '4'.repeat(64)
  };
  const strategyInput: Parameters<TaskStrategyShadowAdvisor['assess']>[0] = {
    task: structuredClone(task),
    goal: { kind: 'browser-navigation', url: 'https://example.test/' },
    decision: { type: 'step', key: 'interact', title: 'Interact', capability: 'browser.interact', input: {} },
    actionId: 'shadow-eval-action', risk: 'write', intelligence: intelligence(), permissions: permissions(),
    result, observation: observation(), sideEffectState: 'uncertain', executionPhase: 'dispatched',
    productionFailure: { class: 'transient', strategy: 'reconcile', retryable: false, code: 'CONNECTION_LOST' },
    outcomeAssessment: recoveryInput.outcomeAssessment,
    recoveryRecommendation: recovery,
    modalityAssessment: modality
  };
  const strategy = new AdaptiveStrategyShadowAdvisor().assess(strategyInput)!;

  task.evidence.push(
    {
      kind: 'adaptive_observation_shadow', status: 'info', message: 'shadow observation', timestamp: NOW,
      data: {
        mode: 'SHADOW', policyVersion: 'adaptive-observation-shadow-v1',
        decisionDigest: '5'.repeat(64), authoritySnapshotDigest: '6'.repeat(64),
        selectedId: 'browser.inspect', controlId: 'browser.inspect', alternatives: ['browser.inspect'], agreement: true,
        actualOk: true, actualProvider: 'browser.cdp', actualDurationMs: 1
      }
    },
    {
      kind: 'adaptive_outcome_shadow', status: 'info', message: 'shadow outcome', timestamp: NOW,
      data: {
        mode: 'SHADOW', policyVersion: 'adaptive-outcome-shadow-v1',
        decisionDigest: '7'.repeat(64), authoritySnapshotDigest: '8'.repeat(64), inputStateDigest: '9'.repeat(64),
        progressLevel: 'NONE', progressConfidence: 1, progressCreditedSignals: [], progressRejectedSignals: [],
        verificationRequired: true, failurePrimaryClass: 'SIDE_EFFECT_UNCERTAIN', failureProbability: 1,
        actualOk: false, productionFailureClass: 'transient', productionFailureStrategy: 'reconcile'
      }
    },
    {
      kind: 'adaptive_plan_node_shadow', status: 'info', message: 'shadow plan node', timestamp: NOW,
      data: {
        mode: 'SHADOW', policyVersion: 'verified-plan-node-shadow-v1',
        decisionDigest: 'a'.repeat(64), authoritySnapshotDigest: 'b'.repeat(64), inputStateDigest: 'c'.repeat(64),
        selectedCapability: 'browser.inspect', controlCapability: 'browser.inspect',
        alternatives: [{ capability: 'browser.inspect', utility: .8, risk: .05 }], agreement: true,
        actualOk: true, actualProvider: 'browser.cdp'
      }
    },
    { kind: 'adaptive_recovery_shadow', status: 'info', message: 'shadow recovery', timestamp: NOW, data: recovery as any },
    { kind: 'adaptive_modality_shadow', status: 'info', message: 'shadow modality', timestamp: NOW, data: modality as any },
    { kind: 'adaptive_strategy_shadow', status: 'info', message: 'shadow strategy', timestamp: NOW, data: strategy as any }
  );
  return task;
}

test('combined six-layer shadow evaluation certifies evidence-only integration without granting control promotion', () => {
  const report = evaluateAdaptiveShadowStack([buildSafeTask()]);
  assert.equal(report.taskCount, 1);
  assert.equal(report.allLayersObserved, true);
  assert.equal(report.safetyViolationCount, 0);
  assert.equal(report.releaseShadowEligible, true);
  assert.equal(report.controlPromotionEligible, false);
  assert.equal(report.layers.length, 6);
  assert.ok(report.layers.every((layer) => layer.available > 0));
  assert.equal(report.reportDigest.length, 64);
});

test('evaluation catches executable payload smuggling and authority expansion', () => {
  const task = buildSafeTask();
  const observationEvidence = task.evidence.find((item) => item.kind === 'adaptive_observation_shadow')!;
  (observationEvidence.data as any).operations = [{ capability: 'browser.interact' }];
  (observationEvidence.data as any).authorityExpanded = true;
  const report = evaluateAdaptiveShadowStack([task]);
  assert.equal(report.releaseShadowEligible, false);
  assert.ok(report.executablePayloadRisks >= 1);
  assert.ok(report.authorityBypassRisks >= 1);
});

test('evaluation catches uncertain mutation modality switching', () => {
  const task = buildSafeTask();
  const modality = task.evidence.find((item) => item.kind === 'adaptive_modality_shadow')!;
  (modality.data as any).switchAllowed = true;
  (modality.data as any).recommendedModality = 'GUI';
  const report = evaluateAdaptiveShadowStack([task]);
  assert.equal(report.releaseShadowEligible, false);
  assert.equal(report.uncertainMutationReplayRisks, 1);
});

test('evaluation catches false goal completion and strategy control authority', () => {
  const task = buildSafeTask();
  const outcome = task.evidence.find((item) => item.kind === 'adaptive_outcome_shadow')!;
  (outcome.data as any).progressLevel = 'GOAL_ACHIEVED';
  (outcome.data as any).verificationRequired = true;
  const strategy = task.evidence.find((item) => item.kind === 'adaptive_strategy_shadow')!;
  (strategy.data as any).controlAllowed = true;
  const report = evaluateAdaptiveShadowStack([task]);
  assert.equal(report.releaseShadowEligible, false);
  assert.equal(report.falseGoalProgressClaims, 1);
  assert.ok(report.controlAuthorityRisks + report.malformedLineage >= 1);
});

test('evaluation refuses to claim all-layer readiness when an applicable shadow layer is absent', () => {
  const task = buildSafeTask();
  task.evidence = task.evidence.filter((item) => item.kind !== 'adaptive_recovery_shadow');
  const report = evaluateAdaptiveShadowStack([task]);
  assert.equal(report.allLayersObserved, false);
  assert.equal(report.releaseShadowEligible, false);
});

test('evaluation never declares control promotion eligibility from structural shadow evidence alone', () => {
  const report = evaluateAdaptiveShadowStack([buildSafeTask()]);
  assert.equal(report.controlPromotionEligible, false);
});
