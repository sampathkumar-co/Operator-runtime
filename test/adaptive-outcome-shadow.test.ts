import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AdaptiveOutcomeShadowAdvisor } from '../src/core/adaptive-outcome-shadow.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { createTask, type TaskObservationSummaryV2 } from '../src/core/task.ts';
import { TaskStore } from '../src/core/task-store.ts';
import {
  TaskOrchestrator,
  type TaskObservation,
  type TaskOutcomeShadowAdvisor,
  type TaskPlanner,
  type TaskPlannerContext
} from '../src/core/task-orchestrator.ts';
import type { ActionResult, PermissionProfile } from '../src/core/types.ts';

async function temp(t: test.TestContext): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'operator-outcome-shadow-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function permissions(root = 'C:/scope'): PermissionProfile {
  return { allowedCapabilities: ['file.info'], allowedRoots: [root], maxRisk: 'read' };
}

function observation(overrides: Partial<TaskObservationSummaryV2> = {}): TaskObservationSummaryV2 {
  return {
    schemaVersion: 2,
    channel: 'semantic',
    domain: 'filesystem',
    provider: 'test-provider',
    capability: 'file.info',
    entityId: 'filesystem:entity',
    observedAt: '2026-10-06T00:00:00.000Z',
    stateVersion: 'a'.repeat(64),
    importantState: { ok: true },
    epistemicStatus: 'KNOWN',
    epistemicReason: 'verified',
    ambiguous: false,
    confidence: 1,
    evidenceRefs: ['b'.repeat(64)],
    ...overrides
  };
}

function input(result: ActionResult, overrides: Record<string, unknown> = {}) {
  const task = createTask({
    userObjective: 'Inspect', interpretedObjective: 'Inspect', authorizedScope: [], prohibitedScope: [], successConditions: ['inspected']
  });
  return {
    task,
    goal: { kind: 'controlled-file-change' as const, root: 'C:/scope', path: 'item', content: 'unused' },
    decision: { type: 'step' as const, key: 'inspect', title: 'Inspect', capability: 'file.info', input: { path: 'item' } },
    actionId: 'action-outcome-shadow',
    risk: 'read' as const,
    permissions: permissions(),
    result,
    observation: observation(),
    sideEffectState: 'none' as const,
    executionPhase: 'effect_observed' as const,
    ...overrides
  };
}

test('outcome shadow credits only explicit provider progress and never claims verified goal completion', () => {
  const advisor = new AdaptiveOutcomeShadowAdvisor({ clock: () => new Date('2026-10-06T00:00:01.000Z') });
  const assessment = advisor.analyze(input({
    ok: true, capability: 'file.info', provider: 'test-provider',
    output: { stateDelta: { progress: true } }, evidence: [], durationMs: 2
  }));
  assert.equal(assessment.mode, 'SHADOW');
  assert.equal(assessment.progress.level, 'SUBGOAL_PROGRESS');
  assert.equal(assessment.progress.verificationRequired, true);
  assert.equal(assessment.failure, undefined);
  assert.match(assessment.decisionDigest, /^[0-9a-f]{64}$/);
});

test('outcome shadow does not invent a first-observation delta and detects only comparable state changes', () => {
  const advisor = new AdaptiveOutcomeShadowAdvisor({ clock: () => new Date('2026-10-06T00:00:02.000Z') });
  const result: ActionResult = {
    ok: true, capability: 'file.info', provider: 'test-provider', output: { exists: true }, evidence: [], durationMs: 1
  };
  const first = advisor.analyze(input(result));
  assert.equal(first.progress.level, 'ACTION_EXECUTED');
  assert.deepEqual(first.progress.rejectedSignals, ['action-ok-without-state-delta']);
  const changed = advisor.analyze(input(result, {
    observation: observation({ observedAt: '2026-10-06T00:00:01.000Z', stateVersion: 'c'.repeat(64), evidenceRefs: ['d'.repeat(64)] }),
    previousObservation: observation({ stateVersion: 'a'.repeat(64) })
  }));
  assert.equal(changed.progress.level, 'STATE_CHANGED');
  assert.ok(changed.progress.creditedSignals.includes('durable-state-delta'));
});

test('outcome shadow attributes uncertain mutation without emitting a recovery command', () => {
  const advisor = new AdaptiveOutcomeShadowAdvisor({ clock: () => new Date('2026-10-06T00:00:01.000Z') });
  const assessment = advisor.analyze(input({
    ok: false, capability: 'file.write', provider: 'test-provider', evidence: [], durationMs: 2,
    error: { code: 'PROVIDER_CONNECTION_LOST', message: 'secret-bearing provider detail', retryable: true, sideEffectState: 'uncertain', executionPhase: 'dispatched' }
  }, {
    risk: 'write',
    decision: { type: 'step', key: 'write', title: 'Write', capability: 'file.write', input: { content: 'secret' } },
    sideEffectState: 'uncertain',
    executionPhase: 'dispatched',
    productionFailure: { class: 'transient', strategy: 'reconcile', retryable: true, code: 'PROVIDER_CONNECTION_LOST' }
  }));
  assert.equal(assessment.failure?.primaryClass, 'SIDE_EFFECT_UNCERTAIN');
  assert.equal('strategy' in (assessment.failure as object), false);
  assert.equal('recovery' in (assessment as object), false);
  assert.doesNotMatch(JSON.stringify(assessment), /secret-bearing|secret/);
});

class OneObservationPlanner implements TaskPlanner {
  readonly id = 'test.outcome-shadow';
  supports(): boolean { return true; }
  next({ task }: TaskPlannerContext) {
    return task.execution?.plannerState.done === true
      ? { type: 'complete' as const, message: 'Observed.' }
      : { type: 'step' as const, key: 'inspect', title: 'Inspect', capability: 'file.info', input: { path: 'unused' } };
  }
  accept({ task }: TaskPlannerContext, _step: any, _observation: TaskObservation): void {
    task.execution!.plannerState.done = true;
  }
}

function contradictoryAssessment(): Awaited<ReturnType<TaskOutcomeShadowAdvisor['analyze']>> {
  return {
    mode: 'SHADOW', policyVersion: 'test-outcome-v1',
    progress: {
      level: 'NONE', confidence: 0, creditedSignals: [], rejectedSignals: ['synthetic-disagreement'], verificationRequired: true
    },
    failure: {
      primaryClass: 'AUTHORITY_DENIED', probability: 1, alternatives: [], entropy: 0, evidenceCoverage: 0
    },
    decisionDigest: 'c'.repeat(64), authoritySnapshotDigest: 'd'.repeat(64), inputStateDigest: 'e'.repeat(64)
  };
}

test('contradictory outcome shadow evidence cannot change successful production completion', async (t) => {
  const root = await temp(t);
  const state = await temp(t);
  let executions = 0;
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime(), store: new TaskStore(state), planners: [new OneObservationPlanner()],
    permissions: permissions(root), outcomeShadow: { analyze: contradictoryAssessment },
    executeAction: async (action) => {
      executions += 1;
      return { ok: true, capability: action.capability, provider: 'control-provider', output: { exists: true }, evidence: [], durationMs: 1 };
    }
  });
  const submitted = await orchestrator.submit({
    objective: 'Observe despite disagreement', authorizedScope: [root], successConditions: ['observed'],
    goal: { kind: 'controlled-file-change', root, path: 'unused', content: 'unused' }
  });
  const completed = await orchestrator.run(submitted.id);
  assert.equal(completed.state, 'VERIFIED');
  assert.equal(executions, 1);
  const shadow = completed.evidence.find((item) => item.kind === 'adaptive_outcome_shadow');
  assert.equal(shadow?.data?.failurePrimaryClass, 'AUTHORITY_DENIED');
  assert.equal(shadow?.data?.actualOk, true);
});

test('outcome shadow failure is fail-open and cannot block production completion', async (t) => {
  const root = await temp(t);
  const state = await temp(t);
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime(), store: new TaskStore(state), planners: [new OneObservationPlanner()],
    permissions: permissions(root), outcomeShadow: { analyze() { throw new Error('shadow unavailable'); } },
    executeAction: async (action) => ({
      ok: true, capability: action.capability, provider: 'control-provider', output: { exists: true }, evidence: [], durationMs: 1
    })
  });
  const submitted = await orchestrator.submit({
    objective: 'Observe despite shadow failure', authorizedScope: [root], successConditions: ['observed'],
    goal: { kind: 'controlled-file-change', root, path: 'unused', content: 'unused' }
  });
  const completed = await orchestrator.run(submitted.id);
  assert.equal(completed.state, 'VERIFIED');
  assert.match(completed.evidence.find((item) => item.kind === 'adaptive_outcome_shadow')?.message ?? '', /unavailable/);
});
