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
  assert.equal(completed.execution?.records.length, 1);
  assert.equal(completed.execution?.records[0]?.state, 'SUCCEEDED');
  assert.ok(completed.evidence.some((item) => item.kind === 'strategy_reobserve'));
});
