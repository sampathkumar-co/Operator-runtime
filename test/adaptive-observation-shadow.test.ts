import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AdaptiveObservationShadowAdvisor } from '../src/core/adaptive-observation-shadow.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { createTask } from '../src/core/task.ts';
import { TaskStore } from '../src/core/task-store.ts';
import {
  TaskOrchestrator,
  type TaskObservation,
  type TaskObservationShadowAdvisor,
  type TaskPlanner,
  type TaskPlannerContext
} from '../src/core/task-orchestrator.ts';
import type { PermissionProfile } from '../src/core/types.ts';

async function temp(t: test.TestContext): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'operator-adaptive-shadow-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function permissions(root: string, capabilities: string[]): PermissionProfile {
  return { allowedCapabilities: capabilities, allowedRoots: [root], maxRisk: 'read' };
}

function intelligence() {
  return {
    retrievedAt: '2026-10-06T00:00:00.000Z', scopeKey: 'scope', world: [], procedures: [], perception: [], strategies: []
  };
}

test('adaptive observation shadow ranks only authorized read candidates and never activates for mutation', () => {
  const task = createTask({ userObjective: 'Inspect', interpretedObjective: 'Inspect', authorizedScope: [], prohibitedScope: [], successConditions: ['observed'] });
  const advisor = new AdaptiveObservationShadowAdvisor({ clock: () => new Date('2026-10-06T00:00:01.000Z') });
  const base = {
    task,
    goal: { kind: 'browser-navigation' as const, url: 'https://example.invalid' },
    decision: { type: 'step' as const, key: 'inspect', title: 'Inspect', capability: 'browser.verify', input: {} },
    actionId: 'action-shadow', intelligence: intelligence()
  };
  const recommendation = advisor.recommend({
    ...base, risk: 'read', permissions: permissions('C:/scope', ['browser.inspect', 'browser.verify'])
  });
  assert.equal(recommendation?.mode, 'SHADOW');
  assert.equal(recommendation?.selectedId, 'browser.inspect');
  assert.equal(recommendation?.controlId, 'browser.verify');
  assert.equal(recommendation?.agreement, false);
  assert.deepEqual(recommendation?.alternatives, ['browser.inspect', 'browser.verify']);
  assert.equal(advisor.recommend({ ...base, risk: 'write', permissions: permissions('C:/scope', ['browser.inspect']) }), undefined);
});

class OneObservationPlanner implements TaskPlanner {
  readonly id = 'test.shadow-observation';
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

test('shadow disagreement is durable evidence but cannot replace the production planner action', async (t) => {
  const root = await temp(t);
  const state = await temp(t);
  const executed: string[] = [];
  const shadow: TaskObservationShadowAdvisor = {
    recommend() {
      return {
        mode: 'SHADOW', policyVersion: 'test-shadow-v1', selectedId: 'file.read', controlId: 'file.info',
        alternatives: ['file.read', 'file.info'], agreement: false,
        decisionDigest: 'a'.repeat(64), authoritySnapshotDigest: 'b'.repeat(64)
      };
    }
  };
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime(), store: new TaskStore(state), planners: [new OneObservationPlanner()],
    permissions: permissions(root, ['file.info', 'file.read']), observationShadow: shadow,
    executeAction: async (action) => {
      executed.push(action.capability);
      return { ok: true, capability: action.capability, provider: 'control-provider', output: { exists: true }, evidence: [], durationMs: 3 };
    }
  });
  const submitted = await orchestrator.submit({
    objective: 'Observe one file', authorizedScope: [root], successConditions: ['observed'],
    goal: { kind: 'controlled-file-change', root, path: 'unused', content: 'unused' }
  });
  const completed = await orchestrator.run(submitted.id);
  assert.equal(completed.state, 'VERIFIED');
  assert.deepEqual(executed, ['file.info']);
  const comparison = completed.evidence.find((item) => item.kind === 'adaptive_observation_shadow');
  assert.equal(comparison?.data?.selectedId, 'file.read');
  assert.equal(comparison?.data?.controlId, 'file.info');
  assert.equal(comparison?.data?.agreement, false);
  assert.equal(comparison?.data?.actualOk, true);
});

test('shadow advisor failure cannot block or alter production control execution', async (t) => {
  const root = await temp(t);
  const state = await temp(t);
  let executions = 0;
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime(), store: new TaskStore(state), planners: [new OneObservationPlanner()],
    permissions: permissions(root, ['file.info']),
    observationShadow: { recommend() { throw new Error('shadow unavailable'); } },
    executeAction: async (action) => {
      executions += 1;
      return { ok: true, capability: action.capability, provider: 'control-provider', output: { exists: true }, evidence: [], durationMs: 1 };
    }
  });
  const submitted = await orchestrator.submit({
    objective: 'Observe despite shadow failure', authorizedScope: [root], successConditions: ['observed'],
    goal: { kind: 'controlled-file-change', root, path: 'unused', content: 'unused' }
  });
  const completed = await orchestrator.run(submitted.id);
  assert.equal(completed.state, 'VERIFIED');
  assert.equal(executions, 1);
  assert.match(completed.evidence.find((item) => item.kind === 'adaptive_observation_shadow')?.message ?? '', /unavailable/);
});
