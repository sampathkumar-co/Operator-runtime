import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AdaptiveModalityShadowAdvisor } from '../src/core/adaptive-modality-shadow.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { createTask, type TaskObservationSummaryV2 } from '../src/core/task.ts';
import { TaskStore } from '../src/core/task-store.ts';
import {
  TaskOrchestrator,
  type TaskModalityShadowAdvisor,
  type TaskObservation,
  type TaskPlanner,
  type TaskPlannerContext
} from '../src/core/task-orchestrator.ts';
import type { PermissionProfile } from '../src/core/types.ts';

type Input = Parameters<TaskModalityShadowAdvisor['assess']>[0];
const NOW = Date.parse('2026-10-06T10:00:00.000Z');

function permissions(capabilities = ['browser.interact']): PermissionProfile {
  return { allowedCapabilities: capabilities, allowedRoots: [], maxRisk: 'write', enterprisePolicyDigest: 'a'.repeat(64), enterprisePolicyGeneration: 9 };
}

function observation(): TaskObservationSummaryV2 {
  return {
    schemaVersion: 2, channel: 'semantic', domain: 'browser', provider: 'browser.cdp', capability: 'browser.interact',
    entityId: 'browser:tab', observedAt: new Date(NOW).toISOString(), stateVersion: 'b'.repeat(64),
    importantState: { target: 'button' }, epistemicStatus: 'KNOWN', epistemicReason: 'verified', ambiguous: false,
    confidence: 1, evidenceRefs: ['c'.repeat(64)]
  };
}

function input(overrides: Partial<Input> = {}): Input {
  const task = createTask({
    userObjective: 'Interact with an observed browser control', interpretedObjective: 'Interact safely',
    authorizedScope: [], prohibitedScope: [], successConditions: ['verified']
  });
  task.execution = {
    schemaVersion: 1, plannerId: 'test.modality', goalKind: 'browser-interaction', plannerState: {},
    maxSteps: 5, maxAttemptsPerStep: 2, timeoutMs: 10_000, stepCount: 1, records: []
  };
  return {
    task,
    goal: { kind: 'browser-interaction', operation: 'click', target: { role: 'button', name: 'Continue' } },
    decision: { type: 'step', key: 'click', title: 'Click', capability: 'browser.interact', input: { operation: 'click' } },
    actionId: 'action-modality', risk: 'write',
    intelligence: {
      retrievedAt: new Date(NOW - 1_000).toISOString(), scopeKey: 'browser', world: [], procedures: [], strategies: [],
      perception: [{ nodeId: 'target', confidence: .9, channels: ['dom'], role: 'button', name: 'Continue' }]
    },
    permissions: permissions(),
    result: { ok: true, capability: 'browser.interact', provider: 'browser.cdp', output: { clicked: true }, evidence: [], durationMs: 23 },
    observation: observation(), sideEffectState: 'known', executionPhase: 'effect_observed',
    outcomeAssessment: {
      mode: 'SHADOW', policyVersion: 'test', progress: { level: 'STATE_CHANGED', confidence: 1, creditedSignals: [], rejectedSignals: [], verificationRequired: true },
      decisionDigest: 'd'.repeat(64), authoritySnapshotDigest: 'e'.repeat(64), inputStateDigest: 'f'.repeat(64)
    },
    ...overrides
  };
}

function advisor() { return new AdaptiveModalityShadowAdvisor({ now: () => NOW, platform: 'win32' }); }

test('capability-denied modality is never recommended as executable', () => {
  assert.equal(advisor().assess(input({ permissions: permissions([]) })), undefined);
});

test('unavailable equivalent ranks below an available structured modality', () => {
  const candidate = input();
  candidate.intelligence.perception.push({ nodeId: 'visual', confidence: .2, channels: ['visual'] });
  const assessment = advisor().assess(candidate)!;
  assert.equal(assessment.recommendedModality, 'DOM');
  const unavailable = assessment.candidates.find((item) => item.modality === 'GUI')!;
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.utility, null);
});

test('stale modality evidence cannot control recommendation', () => {
  const candidate = input();
  candidate.intelligence.retrievedAt = new Date(NOW - 600_000).toISOString();
  candidate.intelligence.perception = [{ nodeId: 'visual', confidence: 1, channels: ['visual'] }];
  const assessment = advisor().assess(candidate)!;
  assert.equal(assessment.candidates.some((item) => item.modality === 'GUI'), false);
  assert.equal(assessment.recommendedModality, 'DOM');
});

test('UIA DOM and GUI alternatives retain the exact production capability and authority ceiling', () => {
  const browser = advisor().assess(input({
    intelligence: { ...input().intelligence, perception: [
      { nodeId: 'dom', confidence: 1, channels: ['dom'] },
      { nodeId: 'gui', confidence: 1, channels: ['visual'] }
    ] }
  }))!;
  assert.equal(browser.capability, 'browser.interact');
  assert.ok(browser.candidates.every((item) => item.predictedRisk === .25));

  const appInput = input({
    decision: { type: 'step', key: 'operate', title: 'Operate', capability: 'app.operate', input: {} },
    permissions: permissions(['app.operate']),
    result: { ok: true, capability: 'app.operate', provider: 'windows.uia', output: {}, evidence: [], durationMs: 3 },
    intelligence: { ...input().intelligence, perception: [{ nodeId: 'uia', confidence: 1, channels: ['uia', 'visual'] }] }
  });
  const app = advisor().assess(appInput)!;
  assert.ok(app.candidates.some((item) => item.modality === 'UIA'));
  assert.equal(app.capability, 'app.operate');
});

test('uncertain browser mutation cannot switch modality and replay blindly', () => {
  const assessment = advisor().assess(input({
    sideEffectState: 'uncertain', executionPhase: 'dispatched',
    result: {
      ok: false, capability: 'browser.interact', provider: 'browser.cdp', evidence: [], durationMs: 50,
      error: { code: 'CONNECTION_LOST', message: 'lost', retryable: true, sideEffectState: 'uncertain', executionPhase: 'dispatched' }
    },
    productionFailure: { class: 'transient', strategy: 'reconcile', retryable: false, code: 'CONNECTION_LOST' }
  }))!;
  assert.equal(assessment.actualProductionModality, 'DOM');
  assert.equal(assessment.recommendedModality, 'DOM');
  assert.equal(assessment.switchAllowed, false);
  assert.equal(assessment.actualOutcome, 'UNCERTAIN');
});

test('identical input is restart-stable and records the required comparison evidence', async (t) => {
  const candidate = input();
  const first = advisor().assess(candidate)!;
  const second = advisor().assess(structuredClone(candidate))!;
  assert.equal(first.assessmentDigest.length, 64);
  assert.deepEqual(second, first);
  assert.equal(first.recommendedModality, 'DOM');
  assert.equal(first.actualProductionModality, 'DOM');
  assert.equal(first.actualOutcome, 'SUCCEEDED');
  assert.equal(first.verificationResult, 'UNRESOLVED');
  assert.equal(first.latencyMs, 23);

  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'operator-modality-shadow-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const value = candidate.task;
  value.evidence.push({ kind: 'adaptive_modality_shadow', status: 'info', message: 'shadow', timestamp: new Date(NOW).toISOString(), data: first });
  await new TaskStore(directory).create(value);
  assert.deepEqual((await new TaskStore(directory).get(value.id)).evidence[0]?.data, first);
});

test('a fresh changed observation can legitimately change the recommendation', () => {
  const base = input({
    result: { ok: true, capability: 'browser.interact', provider: 'playwright-driver', output: {}, evidence: [], durationMs: 1 },
    intelligence: { ...input().intelligence, perception: [] }
  });
  assert.equal(advisor().assess(base)!.recommendedModality, 'PLAYWRIGHT');
  base.intelligence.perception = [{ nodeId: 'dom', confidence: 1, channels: ['dom'] }];
  base.observation = { ...base.observation, stateVersion: '9'.repeat(64), evidenceRefs: ['8'.repeat(64)] };
  assert.equal(advisor().assess(base)!.recommendedModality, 'DOM');
});

test('modality policy contains no benchmark task names or selectors', async () => {
  const source = await fs.readFile(new URL('../src/core/adaptive-modality-shadow.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /mind2web|webarena|workarena|osworld|click-menu|drag-items|tic-tac-toe/i);
});

class OneBrowserObservationPlanner implements TaskPlanner {
  readonly id = 'test.modality-integration';
  supports(): boolean { return true; }
  next({ task }: TaskPlannerContext) {
    return task.execution?.plannerState.done === true
      ? { type: 'complete' as const, message: 'Observed.' }
      : { type: 'step' as const, key: 'inspect', title: 'Inspect', capability: 'browser.inspect', input: {} };
  }
  accept({ task }: TaskPlannerContext, _step: any, _observation: TaskObservation): void { task.execution!.plannerState.done = true; }
}

test('modality disagreement is evidence only and cannot replace production routing', async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'operator-modality-control-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let executions = 0;
  const intelligence = input().intelligence;
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime(), store: new TaskStore(directory), planners: [new OneBrowserObservationPlanner()],
    permissions: { ...permissions(['browser.inspect']), maxRisk: 'read' },
    intelligence: { async retrieve() { return structuredClone(intelligence); } },
    modalityShadow: advisor(),
    executeAction: async (action) => {
      executions += 1;
      return { ok: true, capability: action.capability, provider: 'playwright-driver', output: { tabs: [] }, evidence: [], durationMs: 4 };
    }
  });
  const submitted = await orchestrator.submit({
    objective: 'Observe browser', authorizedScope: [], successConditions: ['observed'],
    goal: { kind: 'controlled-file-change', root: 'C:/scope', path: 'unused', content: 'unused' }
  });
  const completed = await orchestrator.run(submitted.id);
  assert.equal(completed.state, 'VERIFIED');
  assert.equal(executions, 1);
  const evidence = completed.evidence.find((item) => item.kind === 'adaptive_modality_shadow')?.data;
  assert.equal(evidence?.recommendedModality, 'DOM');
  assert.equal(evidence?.actualProductionModality, 'PLAYWRIGHT');
});
