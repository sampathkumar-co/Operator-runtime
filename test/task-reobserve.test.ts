import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { TaskStore } from '../src/core/task-store.ts';
import {
  TaskOrchestrator,
  type PlannerDecision,
  type SemanticTaskGoal,
  type TaskObservation,
  type TaskPlanner,
  type TaskPlannerContext
} from '../src/core/task-orchestrator.ts';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../src/core/types.ts';

const SCORE: CapabilityScore = {
  reliability: 1, latency: 1, determinism: 1, security: 1,
  reversibility: 1, informationQuality: 1, interactionCost: 0
};

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

class StaleThenSuccessBrowserProvider implements CapabilityProvider {
  readonly name = 'test.browser-stale-then-success';
  calls = 0;
  supports(action: ActionRequest): boolean { return action.capability === 'browser.interact'; }
  score(): CapabilityScore { return SCORE; }
  async execute(action: ActionRequest): Promise<ActionResult> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [],
        error: {
          code: 'BROWSER_TARGET_STALE',
          message: 'Target changed before native input dispatch.',
          retryable: true,
          sideEffectState: 'none',
          details: { executionPhase: 'pre_dispatch' }
        },
        durationMs: 0
      };
    }
    return {
      ok: true,
      capability: action.capability,
      provider: this.name,
      output: { dispatched: true },
      evidence: [],
      durationMs: 0
    };
  }
}

class OneBrowserStepPlanner implements TaskPlanner {
  readonly id = 'test.one-browser-step';
  supports(_goal: SemanticTaskGoal): boolean { return true; }
  next({ task }: TaskPlannerContext): PlannerDecision {
    return task.execution!.plannerState.phase === 'complete'
      ? { type: 'complete', message: 'done' }
      : {
          type: 'step',
          key: 'click-once',
          title: 'Click one browser control',
          capability: 'browser.interact',
          input: { operation: 'click', target: { ref: 'ref-1' } }
        };
  }
  accept({ task }: TaskPlannerContext, _step: Extract<PlannerDecision, { type: 'step' }>, observation: TaskObservation): void {
    if (!observation.ok) return;
    task.execution!.plannerState.phase = 'complete';
  }
}

class NoProgressThenSuccessProvider implements CapabilityProvider {
  readonly name = 'test.no-progress-then-success';
  calls = 0;
  supports(action: ActionRequest): boolean { return action.capability === 'browser.interact'; }
  score(): CapabilityScore { return SCORE; }
  async execute(action: ActionRequest): Promise<ActionResult> {
    this.calls += 1;
    if (this.calls === 1) return {
      ok: false, capability: action.capability, provider: this.name, evidence: [], durationMs: 1,
      error: {
        code: 'BROWSER_NO_PROGRESS', message: 'Action completed without a meaningful delta.', retryable: false,
        sideEffectState: 'known', executionPhase: 'effect_observed'
      }
    };
    return { ok: true, capability: action.capability, provider: this.name, output: { stateDelta: { progress: true } }, evidence: [], durationMs: 1 };
  }
}

class EventAwarePlanner implements TaskPlanner {
  readonly id = 'test.event-aware';
  supports(): boolean { return true; }
  next({ task, recentEvents }: TaskPlannerContext): PlannerDecision {
    if (task.execution!.plannerState.phase === 'complete') return { type: 'complete', message: 'replanned' };
    const replanning = recentEvents.some((event) => event.kind === 'ACTION_SUCCEEDED_BUT_NO_PROGRESS' && event.decision === 'REPLAN');
    return {
      type: 'step', key: replanning ? 'alternate-action' : 'stuck-action', title: replanning ? 'Use alternate action' : 'Try initial action',
      capability: 'browser.interact', input: { operation: replanning ? 'key_press' : 'click', target: { ref: 'current' }, ...(replanning ? { key: 'Enter' } : {}) }
    };
  }
  accept({ task }: TaskPlannerContext): void { task.execution!.plannerState.phase = 'complete'; }
}

test('pre-dispatch stale target reobserves without consuming environment step or attempt budget', async (t) => {
  const root = await tempDir(t, 'operator-task-reobserve-root-');
  const state = await tempDir(t, 'operator-task-reobserve-state-');
  const provider = new StaleThenSuccessBrowserProvider();
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime().register(provider),
    store: new TaskStore(state),
    permissions: {
      allowedCapabilities: ['browser.interact'],
      allowedRoots: [root],
      allowExternalWrites: true
    },
    planners: [new OneBrowserStepPlanner()]
  });

  const task = await orchestrator.submit({
    objective: 'Interact once after safe stale-target recovery.',
    authorizedScope: [root],
    successConditions: ['one real interaction succeeds'],
    goal: { kind: 'controlled-file-change', root, path: 'unused.txt', content: 'unused' },
    maxSteps: 1,
    maxAttemptsPerStep: 1
  });

  const completed = await orchestrator.run(task.id);
  assert.equal(completed.state, 'VERIFIED');
  assert.equal(provider.calls, 2);
  assert.equal(completed.execution?.stepCount, 1);
  assert.equal(completed.execution?.dispatchedActions, 1);
  assert.equal(completed.execution?.preDispatchReobserves, 1);
  assert.equal(completed.execution?.plannerIterations, 3);
  assert.equal(completed.execution?.records.length, 1);
  assert.equal(completed.execution?.records[0]?.state, 'SUCCEEDED');
  assert.equal(completed.execution?.records[0]?.executionPhase, 'effect_observed');
  assert.ok(completed.evidence.some((item) => item.kind === 'strategy_reobserve'));
});

test('pre-dispatch approval wait does not consume environment-action budget', async (t) => {
  const root = await tempDir(t, 'operator-task-approval-budget-root-');
  const state = await tempDir(t, 'operator-task-approval-budget-state-');
  let executions = 0;
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime().register(new StaleThenSuccessBrowserProvider()),
    store: new TaskStore(state),
    permissions: {
      allowedCapabilities: ['browser.interact'],
      allowedRoots: [root],
      allowExternalWrites: true
    },
    planners: [new OneBrowserStepPlanner()],
    executeAction: async (action) => {
      executions += 1;
      if (executions === 1) {
        return {
          ok: false, capability: action.capability, provider: 'approval-probe', evidence: [], durationMs: 0,
          error: {
            code: 'APPROVAL_REQUIRED', message: 'approval is needed before dispatch', retryable: false,
            sideEffectState: 'none', executionPhase: 'pre_dispatch'
          }
        };
      }
      return { ok: true, capability: action.capability, provider: 'approval-probe', output: { dispatched: true }, evidence: [], durationMs: 0 };
    }
  });
  const task = await orchestrator.submit({
    objective: 'Approve then execute exactly one environment action.',
    authorizedScope: [root],
    successConditions: ['one approved interaction succeeds'],
    goal: { kind: 'controlled-file-change', root, path: 'unused.txt', content: 'unused' },
    maxSteps: 1,
    maxAttemptsPerStep: 1
  });
  const completed = await orchestrator.run(task.id, [], { onApprovalRequired: () => 'retry' });
  assert.equal(completed.state, 'VERIFIED');
  assert.equal(executions, 2);
  assert.equal(completed.execution?.stepCount, 1);
  assert.equal(completed.execution?.dispatchedActions, 1);
  assert.equal(completed.execution?.records.length, 1);
});

test('no-progress becomes a durable planner event and triggers bounded replanning without blind mutation retry', async (t) => {
  const root = await tempDir(t, 'operator-task-planner-event-root-');
  const state = await tempDir(t, 'operator-task-planner-event-state-');
  const provider = new NoProgressThenSuccessProvider();
  const store = new TaskStore(state);
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime().register(provider), store,
    permissions: { allowedCapabilities: ['browser.interact'], allowedRoots: [root], allowExternalWrites: true },
    planners: [new EventAwarePlanner()]
  });
  const task = await orchestrator.submit({
    objective: 'Replan after a no-progress interaction.', authorizedScope: [root],
    successConditions: ['alternate interaction succeeds'],
    goal: { kind: 'controlled-file-change', root, path: 'unused.txt', content: 'unused' },
    maxSteps: 2, maxAttemptsPerStep: 1
  });
  const completed = await orchestrator.run(task.id);
  assert.equal(completed.state, 'VERIFIED');
  assert.equal(provider.calls, 2);
  assert.deepEqual(completed.execution?.records.map((record) => record.stepKey), ['stuck-action', 'alternate-action']);
  assert.equal(completed.execution?.plannerEvents?.[0]?.kind, 'ACTION_SUCCEEDED_BUT_NO_PROGRESS');
  assert.equal(completed.execution?.plannerEvents?.[0]?.decision, 'REPLAN');
  assert.ok(completed.evidence.some((item) => item.kind === 'strategy_replan'));
  const persisted = await store.get(task.id);
  assert.equal(persisted.execution?.plannerEvents?.[0]?.code, 'BROWSER_NO_PROGRESS');
});
