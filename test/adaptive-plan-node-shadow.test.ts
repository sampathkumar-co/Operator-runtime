import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AdaptivePlanNodeShadowAdvisor } from '../src/core/adaptive-plan-node-shadow.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { createTask } from '../src/core/task.ts';
import { TaskStore } from '../src/core/task-store.ts';
import {
  TaskOrchestrator,
  type TaskObservation,
  type TaskPlanNodeShadowAdvisor,
  type TaskPlanner,
  type TaskPlannerContext
} from '../src/core/task-orchestrator.ts';
import type { PermissionProfile } from '../src/core/types.ts';

async function temp(t: test.TestContext): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'operator-plan-node-shadow-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function permissions(root: string, capabilities: string[], maxRisk: PermissionProfile['maxRisk'] = 'read'): PermissionProfile {
  return { allowedCapabilities: capabilities, allowedRoots: [root], maxRisk };
}

function intelligence() {
  return {
    retrievedAt: '2026-10-06T00:00:00.000Z',
    scopeKey: 'scope',
    world: [], perception: [], strategies: [],
    procedures: [{
      id: 'verified-inspection', confidence: 0.95,
      capabilities: ['file.read', 'file.search', 'browser.interact'],
      verifiedRuns: 9, failedRuns: 1, verificationDigest: 'a'.repeat(64)
    }]
  };
}

test('plan-node shadow ranks only authorized low-risk verified-procedure capabilities', () => {
  const task = createTask({
    userObjective: 'Inspect', interpretedObjective: 'Inspect', authorizedScope: [], prohibitedScope: [], successConditions: ['inspected']
  });
  const advisor = new AdaptivePlanNodeShadowAdvisor({ clock: () => new Date('2026-10-06T00:00:01.000Z') });
  const recommendation = advisor.recommend({
    task,
    goal: { kind: 'controlled-file-change', root: 'C:/scope', path: 'item', content: 'unused' },
    decision: { type: 'step', key: 'inspect', title: 'Inspect', capability: 'file.info', input: { path: 'item' } },
    actionId: 'action-plan-shadow', risk: 'read', intelligence: intelligence(),
    permissions: permissions('C:/scope', ['file.info', 'file.read'])
  });
  assert.equal(recommendation?.mode, 'SHADOW');
  assert.equal(recommendation?.selectedCapability, 'file.read');
  assert.equal(recommendation?.controlCapability, 'file.info');
  assert.equal(recommendation?.agreement, false);
  assert.deepEqual(recommendation?.alternatives.map((item) => item.capability).sort(), ['file.info', 'file.read']);
  assert.equal('input' in (recommendation as object), false);
  assert.match(recommendation?.decisionDigest ?? '', /^[0-9a-f]{64}$/);
  const changedLineage = intelligence();
  changedLineage.procedures[0]!.verificationDigest = 'f'.repeat(64);
  const rebound = advisor.recommend({
    task,
    goal: { kind: 'controlled-file-change', root: 'C:/scope', path: 'item', content: 'unused' },
    decision: { type: 'step', key: 'inspect', title: 'Inspect', capability: 'file.info', input: { path: 'item' } },
    actionId: 'action-plan-shadow', risk: 'read', intelligence: changedLineage,
    permissions: permissions('C:/scope', ['file.info', 'file.read'])
  });
  assert.notEqual(rebound?.decisionDigest, recommendation?.decisionDigest);
});

test('plan-node shadow refuses external-risk control and cannot infer dynamic capability risk', () => {
  const task = createTask({
    userObjective: 'Interact', interpretedObjective: 'Interact', authorizedScope: [], prohibitedScope: [], successConditions: ['done']
  });
  const advisor = new AdaptivePlanNodeShadowAdvisor();
  const recommendation = advisor.recommend({
    task,
    goal: { kind: 'browser-navigation', url: 'https://example.invalid' },
    decision: { type: 'step', key: 'interact', title: 'Interact', capability: 'browser.interact', input: {} },
    actionId: 'external-action', risk: 'external', intelligence: intelligence(),
    permissions: permissions('C:/scope', ['browser.interact', 'project.command.run'], 'external')
  });
  assert.equal(recommendation, undefined);
});

class OneObservationPlanner implements TaskPlanner {
  readonly id = 'test.plan-node-shadow';
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

function disagreement(): Awaited<ReturnType<TaskPlanNodeShadowAdvisor['recommend']>> {
  return {
    mode: 'SHADOW', policyVersion: 'test-plan-node-v1',
    selectedCapability: 'file.read', controlCapability: 'file.info',
    alternatives: [
      { capability: 'file.read', utility: 0.8, risk: 0.05 },
      { capability: 'file.info', utility: 0.6, risk: 0.05 }
    ],
    agreement: false,
    decisionDigest: 'b'.repeat(64), authoritySnapshotDigest: 'c'.repeat(64), inputStateDigest: 'd'.repeat(64)
  };
}

test('plan-node disagreement cannot replace the production planner capability', async (t) => {
  const root = await temp(t);
  const state = await temp(t);
  const executed: string[] = [];
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime(), store: new TaskStore(state), planners: [new OneObservationPlanner()],
    permissions: permissions(root, ['file.info', 'file.read']), planNodeShadow: { recommend: disagreement },
    executeAction: async (action) => {
      executed.push(action.capability);
      return { ok: true, capability: action.capability, provider: 'control-provider', output: { exists: true }, evidence: [], durationMs: 1 };
    }
  });
  const submitted = await orchestrator.submit({
    objective: 'Observe one file', authorizedScope: [root], successConditions: ['observed'],
    goal: { kind: 'controlled-file-change', root, path: 'unused', content: 'unused' }
  });
  const completed = await orchestrator.run(submitted.id);
  assert.equal(completed.state, 'VERIFIED');
  assert.deepEqual(executed, ['file.info']);
  const shadow = completed.evidence.find((item) => item.kind === 'adaptive_plan_node_shadow');
  assert.equal(shadow?.data?.selectedCapability, 'file.read');
  assert.equal(shadow?.data?.actualOk, true);
});

test('plan-node advisor failure cannot block production execution', async (t) => {
  const root = await temp(t);
  const state = await temp(t);
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime(), store: new TaskStore(state), planners: [new OneObservationPlanner()],
    permissions: permissions(root, ['file.info']),
    planNodeShadow: { recommend() { throw new Error('shadow unavailable'); } },
    executeAction: async (action) => ({
      ok: true, capability: action.capability, provider: 'control-provider', output: { exists: true }, evidence: [], durationMs: 1
    })
  });
  const submitted = await orchestrator.submit({
    objective: 'Observe despite plan shadow failure', authorizedScope: [root], successConditions: ['observed'],
    goal: { kind: 'controlled-file-change', root, path: 'unused', content: 'unused' }
  });
  const completed = await orchestrator.run(submitted.id);
  assert.equal(completed.state, 'VERIFIED');
  assert.match(completed.evidence.find((item) => item.kind === 'adaptive_plan_node_shadow')?.message ?? '', /unavailable/);
});
