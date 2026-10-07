import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AdaptiveStrategyShadowAdvisor,
  validateStrategyShadowAssessment
} from '../src/core/adaptive-strategy-shadow.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { createTask, type TaskCapsule, type TaskObservationSummaryV2 } from '../src/core/task.ts';
import { TaskStore } from '../src/core/task-store.ts';
import {
  TaskOrchestrator,
  type TaskIntelligenceContext,
  type TaskObservation,
  type TaskPlanner,
  type TaskPlannerContext,
  type TaskStrategyShadowAdvisor
} from '../src/core/task-orchestrator.ts';
import type { ActionResult, PermissionProfile } from '../src/core/types.ts';

type StrategyInput = Parameters<TaskStrategyShadowAdvisor['assess']>[0];

function permissions(generation = 9): PermissionProfile {
  return {
    allowedCapabilities: ['browser.inspect', 'browser.interact'],
    allowedRoots: ['C:/scope'],
    maxRisk: 'write',
    enterprisePolicyDigest: 'a'.repeat(64),
    enterprisePolicyGeneration: generation
  };
}

function intelligence(): TaskIntelligenceContext {
  return {
    retrievedAt: '2026-10-06T12:00:00.000Z',
    scopeKey: 'scope',
    world: [],
    procedures: [
      { id: 'current', confidence: .9, capabilities: ['browser.inspect'], verifiedRuns: 4, failedRuns: 0, verificationDigest: '1'.repeat(64) },
      { id: 'alternate', confidence: .8, capabilities: ['browser.inspect'], verifiedRuns: 3, failedRuns: 1, verificationDigest: '2'.repeat(64) }
    ],
    perception: [{ nodeId: 'dom', confidence: 1, channels: ['dom'] }],
    strategies: []
  };
}

function observation(status: TaskObservationSummaryV2['epistemicStatus'] = 'KNOWN'): TaskObservationSummaryV2 {
  return {
    schemaVersion: 2,
    channel: 'semantic',
    domain: 'browser',
    provider: 'browser.cdp',
    capability: 'browser.inspect',
    entityId: 'browser:tab',
    observedAt: '2026-10-06T12:00:00.000Z',
    stateVersion: 'b'.repeat(64),
    importantState: { url: 'https://example.test/' },
    epistemicStatus: status,
    epistemicReason: status === 'KNOWN' ? 'verified' : 'needs-refresh',
    ambiguous: status === 'AMBIGUOUS',
    confidence: status === 'KNOWN' ? 1 : .2,
    evidenceRefs: ['c'.repeat(64)]
  };
}

function task(): TaskCapsule {
  const value = createTask({
    userObjective: 'Safely inspect one browser state',
    interpretedObjective: 'Safely inspect one browser state',
    authorizedScope: ['https://example.test/'],
    prohibitedScope: [],
    successConditions: ['verified']
  });
  value.execution = {
    schemaVersion: 1,
    plannerId: 'test.strategy',
    goalKind: 'browser-navigation',
    plannerState: { durablePlan: { revision: 4, facts: [{ id: 'known', status: 'ACTIVE' }] } },
    maxSteps: 10,
    maxAttemptsPerStep: 3,
    timeoutMs: 10_000,
    stepCount: 1,
    plannerIterations: 1,
    progressExtensions: 0,
    progressProofDigests: [],
    preDispatchReobserves: 0,
    dispatchedActions: 1,
    records: []
  };
  return value;
}

function input(overrides: Partial<StrategyInput> = {}): StrategyInput {
  const result: ActionResult = {
    ok: true,
    capability: 'browser.inspect',
    provider: 'browser.cdp',
    output: { url: 'https://example.test/' },
    evidence: [],
    durationMs: 5
  };
  return {
    task: task(),
    goal: { kind: 'browser-navigation', url: 'https://example.test/' },
    decision: { type: 'step', key: 'inspect', title: 'Inspect', capability: 'browser.inspect', input: {} },
    actionId: 'strategy-shadow-action',
    risk: 'read',
    intelligence: intelligence(),
    permissions: permissions(),
    result,
    observation: observation(),
    sideEffectState: 'none',
    executionPhase: 'effect_observed',
    ...overrides
  };
}

test('successful provider result remains verification-oriented shadow evidence and never gains control', () => {
  const assessment = new AdaptiveStrategyShadowAdvisor().assess(input())!;
  assert.equal(assessment.mode, 'SHADOW');
  assert.equal(assessment.controlAllowed, false);
  assert.equal(assessment.recommendedStrategy, 'VERIFY');
  assert.equal(assessment.productionStrategy, 'CONTINUE_CURRENT_BRANCH');
  assert.equal(assessment.assessmentDigest.length, 64);
  const text = JSON.stringify(assessment);
  assert.doesNotMatch(text, /"input"|"target"|"dispatch"|"operations"/);
});

test('policy or approval denial can only fail safe and cannot become an alternate-strategy bypass', () => {
  const assessment = new AdaptiveStrategyShadowAdvisor().assess(input({
    result: {
      ok: false, capability: 'browser.inspect', provider: 'policy', evidence: [], durationMs: 1,
      error: { code: 'POLICY_DENIED', message: 'denied', retryable: false, sideEffectState: 'none', executionPhase: 'pre_dispatch' }
    },
    productionFailure: { class: 'policy', strategy: 'fail', retryable: false, code: 'POLICY_DENIED' },
    executionPhase: 'pre_dispatch'
  }))!;
  assert.equal(assessment.recommendedStrategy, 'STOP_UNRESOLVED');
  assert.deepEqual(assessment.candidates.map((item) => item.kind), ['STOP_UNRESOLVED']);
});

test('uncertain mutation can only reconcile or fail safe and never switches strategy to replay', () => {
  const assessment = new AdaptiveStrategyShadowAdvisor().assess(input({
    decision: { type: 'step', key: 'interact', title: 'Interact', capability: 'browser.interact', input: {} },
    risk: 'write',
    result: {
      ok: false, capability: 'browser.interact', provider: 'browser.cdp', evidence: [], durationMs: 7,
      error: { code: 'CONNECTION_LOST', message: 'lost', retryable: true, sideEffectState: 'uncertain', executionPhase: 'dispatched' }
    },
    sideEffectState: 'uncertain',
    executionPhase: 'dispatched',
    productionFailure: { class: 'transient', strategy: 'reconcile', retryable: false, code: 'CONNECTION_LOST' }
  }))!;
  assert.equal(assessment.recommendedStrategy, 'RECONCILE');
  assert.ok(assessment.candidates.every((item) => item.kind === 'RECONCILE' || item.kind === 'STOP_UNRESOLVED'));
});

test('unknown or contradicted knowledge forces observation-first or fail-safe strategy', () => {
  for (const status of ['UNKNOWN', 'CONTRADICTED', 'UNAVAILABLE'] as const) {
    const assessment = new AdaptiveStrategyShadowAdvisor().assess(input({ observation: observation(status) }))!;
    assert.equal(assessment.recommendedStrategy, 'OBSERVE_THEN_CONTINUE');
    assert.ok(assessment.candidates.every((item) => item.kind === 'OBSERVE_THEN_CONTINUE' || item.kind === 'STOP_UNRESOLVED'));
  }
});

test('unauthorized observation and failed irreversible action fail safe', () => {
  const unauthorized = new AdaptiveStrategyShadowAdvisor().assess(input({ observation: observation('UNAUTHORIZED') }))!;
  assert.equal(unauthorized.recommendedStrategy, 'STOP_UNRESOLVED');

  const irreversible = new AdaptiveStrategyShadowAdvisor().assess(input({
    decision: { type: 'step', key: 'delete', title: 'Delete', capability: 'browser.interact', input: {} },
    risk: 'destructive',
    permissions: { ...permissions(), maxRisk: 'destructive', allowDestructive: true },
    result: {
      ok: false, capability: 'browser.interact', provider: 'browser.cdp', evidence: [], durationMs: 2,
      error: { code: 'DELETE_FAILED', message: 'failed', retryable: false, sideEffectState: 'known', executionPhase: 'effect_observed' }
    },
    sideEffectState: 'known',
    productionFailure: { class: 'permanent', strategy: 'fail', retryable: false, code: 'DELETE_FAILED' }
  }))!;
  assert.equal(irreversible.recommendedStrategy, 'STOP_UNRESOLVED');
});

test('strategy lineage rejects plan-version authority-generation and digest replay', () => {
  const assessment = new AdaptiveStrategyShadowAdvisor().assess(input())!;
  assert.equal(validateStrategyShadowAssessment(assessment, {
    taskId: assessment.taskId, planVersion: 4, authorityGeneration: 9
  }).assessmentDigest, assessment.assessmentDigest);
  assert.throws(() => validateStrategyShadowAssessment(assessment, { planVersion: 5 }), /plan-version replay/);
  assert.throws(() => validateStrategyShadowAssessment(assessment, { authorityGeneration: 10 }), /authority-generation replay/);
  const tampered = structuredClone(assessment);
  tampered.recommendedStrategy = 'GLOBAL_REPLAN';
  assert.throws(() => validateStrategyShadowAssessment(tampered), /digest mismatch/);
});

test('three repeated equivalent shadow strategies force a global replan or fail-safe instead of looping', () => {
  const advisor = new AdaptiveStrategyShadowAdvisor();
  const candidate = input();
  const first = advisor.assess(candidate)!;
  candidate.task.evidence.push(
    { kind: 'adaptive_strategy_shadow', status: 'info', message: 'prior', timestamp: new Date().toISOString(), data: first },
    { kind: 'adaptive_strategy_shadow', status: 'info', message: 'prior', timestamp: new Date().toISOString(), data: first },
    { kind: 'adaptive_strategy_shadow', status: 'info', message: 'prior', timestamp: new Date().toISOString(), data: first }
  );
  const bounded = advisor.assess(candidate)!;
  assert.equal(bounded.semanticLoopCount, 3);
  assert.ok(['GLOBAL_REPLAN', 'STOP_UNRESOLVED'].includes(bounded.recommendedStrategy));
  assert.ok(bounded.candidates.every((item) => item.kind === 'GLOBAL_REPLAN' || item.kind === 'STOP_UNRESOLVED'));
});

test('durable task restart preserves exact strategy lineage and corruption fails closed', async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'operator-strategy-shadow-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const value = task();
  delete value.execution!.plannerState.durablePlan;
  const assessment = new AdaptiveStrategyShadowAdvisor().assess(input({ task: value }))!;
  value.evidence.push({
    kind: 'adaptive_strategy_shadow', status: 'info', message: 'shadow', timestamp: new Date().toISOString(), data: assessment
  });
  const store = new TaskStore(directory);
  await store.create(value);
  const restarted = await new TaskStore(directory).get(value.id);
  assert.deepEqual(restarted.evidence.at(-1)?.data, assessment);

  const corrupted = structuredClone(restarted);
  const data = corrupted.evidence.at(-1)!.data as any;
  data.controlAllowed = true;
  await assert.rejects(() => store.put(corrupted), (error: any) => error?.code === 'TASK_STATE_CORRUPT');
});

class OneObservationPlanner implements TaskPlanner {
  readonly id = 'test.strategy-control';
  supports(): boolean { return true; }
  next({ task }: TaskPlannerContext) {
    return task.execution?.plannerState.done === true
      ? { type: 'complete' as const, message: 'Observed.' }
      : { type: 'step' as const, key: 'inspect', title: 'Inspect', capability: 'browser.inspect', input: {} };
  }
  accept({ task }: TaskPlannerContext, _step: any, _observation: TaskObservation): void {
    task.execution!.plannerState.done = true;
  }
}

test('strategy disagreement remains evidence only and cannot replace production planner control', async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'operator-strategy-control-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let executions = 0;
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime(),
    store: new TaskStore(directory),
    planners: [new OneObservationPlanner()],
    permissions: permissions(),
    intelligence: { async retrieve() { return intelligence(); } },
    strategyShadow: new AdaptiveStrategyShadowAdvisor(),
    executeAction: async (action) => {
      executions += 1;
      return {
        ok: true, capability: action.capability, provider: 'browser.cdp',
        output: { url: 'https://example.test/' }, evidence: [], durationMs: 2
      };
    }
  });
  const submitted = await orchestrator.submit({
    objective: 'Observe browser',
    authorizedScope: [],
    successConditions: ['observed'],
    goal: { kind: 'controlled-file-change', root: 'C:/scope', path: 'unused', content: 'unused' }
  });
  const completed = await orchestrator.run(submitted.id);
  assert.equal(executions, 1);
  const evidence = completed.evidence.find((item) => item.kind === 'adaptive_strategy_shadow')?.data;
  assert.equal(evidence?.controlAllowed, false);
  assert.equal(evidence?.recommendedStrategy, 'VERIFY');
});

test('strategy shadow failure is fail-open and cannot replace production control', async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'operator-strategy-unavailable-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let executions = 0;
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime(),
    store: new TaskStore(directory),
    planners: [new OneObservationPlanner()],
    permissions: permissions(),
    intelligence: { async retrieve() { return intelligence(); } },
    strategyShadow: { assess() { throw new Error('shadow unavailable'); } },
    executeAction: async (action) => {
      executions += 1;
      return {
        ok: true, capability: action.capability, provider: 'browser.cdp',
        output: { url: 'https://example.test/' }, evidence: [], durationMs: 2
      };
    }
  });
  const submitted = await orchestrator.submit({
    objective: 'Observe browser',
    authorizedScope: [],
    successConditions: ['observed'],
    goal: { kind: 'controlled-file-change', root: 'C:/scope', path: 'unused', content: 'unused' }
  });
  const completed = await orchestrator.run(submitted.id);
  assert.equal(executions, 1);
  assert.ok(completed.evidence.some((item) => item.kind === 'adaptive_strategy_shadow_unavailable'));
});

test('strategy shadow source contains no benchmark task names or selectors', async () => {
  const source = await fs.readFile(new URL('../src/core/adaptive-strategy-shadow.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /mind2web|webarena|workarena|osworld|click-menu|drag-items|generate-number|tic-tac-toe/i);
});
