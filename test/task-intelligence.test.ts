import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BoundedTaskIntelligence } from '../src/core/task-intelligence.ts';
import { WorldModelStore, worldValueDigest } from '../src/core/world-model.ts';
import { ProcedureMemoryStore } from '../src/core/procedure-memory.ts';
import { PerceptionGraphStore, perceptionDigest } from '../src/core/perception-graph.ts';
import { ExecutionOptimizerStore } from '../src/core/execution-optimizer.ts';
import { createTask } from '../src/core/task.ts';

async function temp(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-task-intelligence-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Task intelligence retrieval is bounded, relevant, and omits raw world values', async (t) => {
  const state = await temp(t);
  const world = new WorldModelStore(state);
  const procedures = new ProcedureMemoryStore(state);
  const perception = new PerceptionGraphStore(state);
  const optimizer = new ExecutionOptimizerStore(state);
  const root = 'C:/workspace/project';
  const digest = worldValueDigest('private-project-value');
  await world.observe({
    entity: { key: 'project:one', type: 'project', scopeKey: root, label: 'Project' },
    source: 'test', domain: 'project', evidenceDigest: digest,
    facts: { status: 'private-project-value' }, confidence: 0.9
  });
  await procedures.recordVerified({
    key: 'verified-build', title: 'Verified build', objectiveKind: 'controlled-file-change', scopeKey: root,
    steps: [{ capability: 'filesystem.write', risk: 'write', summary: 'Write the authorized file.' }],
    assumptions: [], verificationDigest: 'a'.repeat(64), verifierEvidenceDigest: 'b'.repeat(64)
  });
  await optimizer.record('task:controlled-file-change', 'fresh-plan', { verified: true, durationMs: 10 });
  const goal = { kind: 'controlled-file-change' as const, root, path: 'a.txt', content: 'ok' };
  const task = createTask({
    userObjective: 'Update one file', interpretedObjective: 'controlled-file-change:Update one file',
    authorizedScope: [root], prohibitedScope: [], successConditions: ['file updated']
  });
  const context = await new BoundedTaskIntelligence({ world, procedures, perception, optimizer }).retrieve({
    task, goal, recentEvents: [],
    budget: { maxSteps: 5, usedSteps: 0, remainingSteps: 5, plannerIterations: 1, preDispatchReobserves: 0, dispatchedActions: 0, maxAttemptsPerStep: 2, activeDeadlineMsRemaining: 1000 }
  });
  assert.equal(context.scopeKey, root);
  assert.equal(context.world[0]?.facts[0]?.key, 'status');
  assert.deepEqual(context.world[0]?.facts[0]?.evidenceDigests, [digest]);
  assert.equal(JSON.stringify(context).includes('private-project-value'), false);
  assert.deepEqual(context.procedures[0]?.capabilities, ['filesystem.write']);
  assert.ok(context.strategies.some((strategy) => strategy.id === 'fresh-plan'));
});

test('Task intelligence retrieves only perception bound to the goal scene', async (t) => {
  const state = await temp(t);
  const world = new WorldModelStore(state);
  const procedures = new ProcedureMemoryStore(state);
  const perception = new PerceptionGraphStore(state);
  const optimizer = new ExecutionOptimizerStore(state);
  await perception.observe({
    sceneKey: 'uia:process:77', channel: 'uia', source: 'windows.uia', semanticId: 'save',
    role: 'button', name: 'Save', bounds: { x: 1, y: 2, width: 3, height: 4 }, state: {},
    confidence: 1, evidenceDigest: perceptionDigest('save')
  });
  await perception.observe({
    sceneKey: 'uia:process:88', channel: 'uia', source: 'windows.uia', semanticId: 'other',
    role: 'button', name: 'Other', state: {}, confidence: 1, evidenceDigest: perceptionDigest('other')
  });
  const goal = { kind: 'app-operation' as const, operation: 'invoke' as const, selector: { processId: 77, automationId: 'save' }, verifySelector: { processId: 77, automationId: 'save' } };
  const task = createTask({
    userObjective: 'Save', interpretedObjective: 'app-operation:Save', authorizedScope: [], prohibitedScope: [], successConditions: ['saved']
  });
  const context = await new BoundedTaskIntelligence({ world, procedures, perception, optimizer }).retrieve({
    task, goal, recentEvents: [],
    budget: { maxSteps: 5, usedSteps: 0, remainingSteps: 5, plannerIterations: 1, preDispatchReobserves: 0, dispatchedActions: 0, maxAttemptsPerStep: 2, activeDeadlineMsRemaining: 1000 }
  });
  assert.equal(context.sceneKey, 'uia:process:77');
  assert.deepEqual(context.perception.map((item) => item.name), ['Save']);
});
