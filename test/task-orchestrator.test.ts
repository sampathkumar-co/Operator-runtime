import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FilesystemProvider } from '../src/capabilities/filesystem.ts';
import { GitProvider } from '../src/capabilities/git.ts';
import { ProjectCommandProvider } from '../src/capabilities/project-command.ts';
import { ProjectInspectProvider } from '../src/capabilities/project.ts';
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
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore, PermissionProfile } from '../src/core/types.ts';
import { supportedGitAvailable } from './git-test-support.ts';

const SCORE: CapabilityScore = {
  reliability: 1, latency: 1, determinism: 1, security: 1,
  reversibility: 1, informationQuality: 1, interactionCost: 0
};

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function permissions(root: string, capabilities: string[]): PermissionProfile {
  return {
    allowedCapabilities: capabilities,
    allowedRoots: [root],
    allowDestructive: false,
    allowExternalWrites: false,
    allowSystemChanges: false
  };
}

function filesystem(root: string): FilesystemProvider {
  return new FilesystemProvider({
    allowedRoots: [root],
    windowsPathLeaseExecutable: process.platform === 'win32'
      ? path.resolve('native/windows-path-lease/target/release/operator-windows-path-lease.exe')
      : undefined
  });
}

test('task executor completes and durably verifies a real semantic multi-action file goal', async (t) => {
  if (!supportedGitAvailable()) { t.skip('supported Git executable is unavailable'); return; }
  const root = await tempDir(t, 'operator-task-goal-');
  const state = await tempDir(t, 'operator-task-state-');
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => execFile('git', ['init', '--quiet'], { cwd: root }, (error) => error ? reject(error) : resolve()));
  const runtime = new OperatorRuntime()
    .register(filesystem(root))
    .register(new GitProvider({ allowedRoots: [root] }));
  const store = new TaskStore(state);
  const orchestrator = new TaskOrchestrator({
    runtime, store,
    permissions: permissions(root, ['file.list', 'file.create', 'file.read', 'git.status'])
  });

  const submitted = await orchestrator.submit({
    objective: 'Create a durable generated file and prove Git observes it.',
    authorizedScope: [root],
    successConditions: ['exact content is readable', 'Git reports the file'],
    goal: { kind: 'controlled-file-change', root, path: 'generated.txt', content: 'durable task output\n' }
  });
  const completed = await orchestrator.run(submitted.id);

  assert.equal(completed.state, 'VERIFIED');
  assert.equal(await fs.readFile(path.join(root, 'generated.txt'), 'utf8'), 'durable task output\n');
  assert.deepEqual(completed.nodes.map((node) => node.state), ['VERIFIED', 'VERIFIED', 'VERIFIED', 'VERIFIED']);
  assert.equal(completed.execution?.stepCount, 4);
  assert.deepEqual(completed.execution?.records.map((record) => record.state), ['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
  assert.deepEqual(completed.execution?.records.map((record) => record.observation?.domain), ['filesystem', 'filesystem', 'filesystem', 'git']);
  assert.ok(completed.execution?.records.every((record) => record.observation?.channel === 'semantic'));
  assert.equal(new Set(completed.execution?.records.map((record) => record.actionId)).size, 4);
  assert.ok(completed.execution?.records.every((record) => /^task-[0-9a-f]{64}$/.test(record.actionId)));
  assert.deepEqual(await store.get(submitted.id), completed);
});

test('task executor discovers and runs only a trusted registered project command', async (t) => {
  const root = await tempDir(t, 'operator-task-command-project-');
  const authority = await tempDir(t, 'operator-task-command-authority-');
  const state = await tempDir(t, 'operator-task-command-state-');
  const marker = path.join(root, 'verified.marker');
  const registryPath = path.join(authority, 'commands.json');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'task-fixture' }));
  await fs.writeFile(registryPath, JSON.stringify({
    version: 1,
    projects: [{
      root,
      commands: [{
        id: 'trusted-test', kind: 'test', executable: 'node',
        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'passed')`],
        cwd: '.', risk: 'read', artifacts: [{ path: 'verified.marker', kind: 'file', minBytes: 1, mustChange: true }]
      }]
    }]
  }));
  const runtime = new OperatorRuntime()
    .register(new ProjectInspectProvider({ allowedRoots: [root] }))
    .register(new ProjectCommandProvider({ allowedRoots: [root], allowedExecutables: ['node'], registryPath }));
  const orchestrator = new TaskOrchestrator({
    runtime, store: new TaskStore(state),
    permissions: permissions(root, ['project.inspect', 'project.command.inspect', 'project.command.run'])
  });
  const submitted = await orchestrator.submit({
    objective: 'Run the trusted test workflow.', authorizedScope: [root],
    successConditions: ['registered test command succeeds', 'registered artifact validation passes'],
    goal: { kind: 'trusted-project-command', root, commandKind: 'test' }
  });

  const completed = await orchestrator.run(submitted.id);
  assert.equal(completed.state, 'VERIFIED');
  assert.equal(await fs.readFile(marker, 'utf8'), 'passed');
  assert.equal(completed.execution?.plannerState.commandId, 'trusted-test');
  assert.deepEqual(completed.execution?.records.map((record) => record.capability), [
    'project.inspect', 'project.command.inspect', 'project.command.run'
  ]);
});

test('task executor recovers an interrupted create without duplicating the mutation', async (t) => {
  if (!supportedGitAvailable()) { t.skip('supported Git executable is unavailable'); return; }
  const root = await tempDir(t, 'operator-task-recovery-');
  const state = await tempDir(t, 'operator-task-recovery-state-');
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => execFile('git', ['init', '--quiet'], { cwd: root }, (error) => error ? reject(error) : resolve()));
  const target = path.join(root, 'recovered.txt');
  const content = 'already committed by interrupted action\n';
  const runtime = new OperatorRuntime().register(filesystem(root)).register(new GitProvider({ allowedRoots: [root] }));
  const store = new TaskStore(state);
  const orchestrator = new TaskOrchestrator({
    runtime, store, permissions: permissions(root, ['file.create', 'file.read', 'git.status'])
  });
  const task = await orchestrator.submit({
    objective: 'Recover a create after process interruption.', authorizedScope: [root],
    successConditions: ['do not duplicate mutation', 'verify exact content'],
    goal: { kind: 'controlled-file-change', root, path: target, content }
  });
  await fs.writeFile(target, content);
  task.state = 'RUNNING';
  task.execution!.plannerState.phase = 'create';
  task.execution!.startedAt = new Date().toISOString();
  task.execution!.deadlineAt = new Date(Date.now() + 60_000).toISOString();
  task.execution!.stepCount = 1;
  const inputHash = crypto.createHash('sha256').update(JSON.stringify({ content, path: target })).digest('hex');
  task.execution!.records.push({
    stepKey: 'create-file', actionId: `task-${'a'.repeat(64)}`, capability: 'file.create', risk: 'write',
    inputHash, attempt: 1, state: 'STARTED', startedAt: new Date().toISOString(), evidence: []
  });
  task.nodes.push({ id: crypto.randomUUID(), title: 'Create requested file', state: 'RUNNING', required: true, dependsOn: [], evidence: [] });
  await store.put(task);

  const recovered = await orchestrator.run(task.id);
  assert.equal(recovered.state, 'VERIFIED');
  assert.equal(await fs.readFile(target, 'utf8'), content);
  assert.equal(recovered.execution?.records[0]?.state, 'INTERRUPTED');
  assert.equal(recovered.execution?.records[1]?.state, 'FAILED');
  assert.equal(recovered.execution?.records[1]?.errorCode, 'TARGET_EXISTS');
  assert.ok(recovered.evidence.some((item) => item.kind === 'strategy_fallback'));
});

class ReplacePlanner implements TaskPlanner {
  readonly id = 'test.replace';
  supports(goal: SemanticTaskGoal): boolean { return goal.kind === 'controlled-file-change'; }
  next({ task, goal }: TaskPlannerContext): PlannerDecision {
    if (task.execution!.plannerState.phase === 'complete') return { type: 'complete', message: 'replacement verified' };
    assert.equal(goal.kind, 'controlled-file-change');
    return {
      type: 'step', key: 'replace', title: 'Replace exact file', capability: 'file.replace',
      input: { path: goal.path, content: goal.content, expectedSha256: task.execution!.plannerState.expectedSha256 }
    };
  }
  accept({ task }: TaskPlannerContext, _step: Extract<PlannerDecision, { type: 'step' }>, observation: TaskObservation): void {
    assert.equal(observation.channel, 'semantic');
    task.execution!.plannerState.phase = 'complete';
  }
}

test('blocked destructive task resumes only with its deterministic explicit approval', async (t) => {
  const root = await tempDir(t, 'operator-task-approval-');
  const state = await tempDir(t, 'operator-task-approval-state-');
  const target = path.join(root, 'target.txt');
  await fs.writeFile(target, 'before');
  const expectedSha256 = crypto.createHash('sha256').update('before').digest('hex');
  const planner = new ReplacePlanner();
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime().register(filesystem(root)),
    store: new TaskStore(state), permissions: permissions(root, ['file.replace']), planners: [planner]
  });
  const submitted = await orchestrator.submit({
    objective: 'Replace an existing file.', authorizedScope: [root], successConditions: ['content replaced'],
    goal: { kind: 'controlled-file-change', root, path: target, content: 'after' }
  });
  submitted.execution!.plannerState.expectedSha256 = expectedSha256;
  await new TaskStore(state).put(submitted);

  const blocked = await orchestrator.run(submitted.id);
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(await fs.readFile(target, 'utf8'), 'before');
  const actionId = blocked.execution!.records[0]!.actionId;
  const completed = await orchestrator.resume(submitted.id, [actionId]);
  assert.equal(completed.state, 'VERIFIED');
  assert.equal(await fs.readFile(target, 'utf8'), 'after');
  assert.equal(completed.execution!.records.length, 1);
  assert.equal(completed.execution!.records[0]!.actionId, actionId);
});

class StuckPlanner implements TaskPlanner {
  readonly id = 'test.stuck';
  supports(): boolean { return true; }
  next({ task, goal }: TaskPlannerContext): PlannerDecision {
    assert.equal(goal.kind, 'controlled-file-change');
    return { type: 'step', key: 'stuck-read', title: 'Stuck read', capability: 'file.read', input: { path: goal.path } };
  }
  accept(): void {}
}

test('task executor detects a no-progress planner loop before exhausting the global step budget', async (t) => {
  const root = await tempDir(t, 'operator-task-loop-');
  const state = await tempDir(t, 'operator-task-loop-state-');
  const target = path.join(root, 'input.txt');
  await fs.writeFile(target, 'data');
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime().register(filesystem(root)),
    store: new TaskStore(state), permissions: permissions(root, ['file.read']), planners: [new StuckPlanner()]
  });
  const task = await orchestrator.submit({
    objective: 'Exercise bounded loop detection.', authorizedScope: [root], successConditions: ['stop safely'],
    goal: { kind: 'controlled-file-change', root, path: target, content: 'unused' },
    maxSteps: 20, maxAttemptsPerStep: 5
  });
  const failed = await orchestrator.run(task.id);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.failures.at(-1)?.code, 'TASK_LOOP_DETECTED');
  assert.equal(failed.execution?.stepCount, 2);
});

class DelayedProvider implements CapabilityProvider {
  readonly name = 'test.delayed';
  started!: () => void;
  release!: () => void;
  readonly startedPromise: Promise<void>;
  readonly releasePromise: Promise<void>;
  constructor() {
    this.startedPromise = new Promise((resolve) => { this.started = resolve; });
    this.releasePromise = new Promise((resolve) => { this.release = resolve; });
  }
  supports(action: ActionRequest): boolean { return action.capability === 'file.read'; }
  score(): CapabilityScore { return SCORE; }
  async execute(action: ActionRequest): Promise<ActionResult> {
    this.started();
    await this.releasePromise;
    return { ok: true, capability: action.capability, provider: this.name, output: { content: 'ok' }, evidence: [], durationMs: 0 };
  }
}

class OneStepPlanner implements TaskPlanner {
  readonly id = 'test.one-step';
  supports(): boolean { return true; }
  next({ task }: TaskPlannerContext): PlannerDecision {
    return task.execution!.plannerState.phase === 'complete'
      ? { type: 'complete', message: 'done' }
      : { type: 'step', key: 'one', title: 'One delayed action', capability: 'file.read', input: { path: 'input.txt' } };
  }
  accept({ task }: TaskPlannerContext): void { task.execution!.plannerState.phase = 'complete'; }
}

test('an in-flight pause survives action completion and can be resumed durably', async (t) => {
  const root = await tempDir(t, 'operator-task-pause-');
  const state = await tempDir(t, 'operator-task-pause-state-');
  const provider = new DelayedProvider();
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime().register(provider), store: new TaskStore(state),
    permissions: permissions(root, ['file.read']), planners: [new OneStepPlanner()]
  });
  const task = await orchestrator.submit({
    objective: 'Pause safely.', authorizedScope: [root], successConditions: ['resume to completion'],
    goal: { kind: 'controlled-file-change', root, path: 'input.txt', content: 'unused' }
  });
  const running = orchestrator.run(task.id);
  await provider.startedPromise;
  assert.equal((await orchestrator.pause(task.id)).state, 'PAUSED');
  provider.release();
  const paused = await running;
  assert.equal(paused.state, 'PAUSED');
  assert.equal(paused.execution?.records[0]?.state, 'SUCCEEDED');
  assert.equal((await orchestrator.resume(task.id)).state, 'VERIFIED');
});

test('a durable execution lease prevents a second orchestrator from duplicating an in-flight action', async (t) => {
  const root = await tempDir(t, 'operator-task-exclusive-');
  const state = await tempDir(t, 'operator-task-exclusive-state-');
  const provider = new DelayedProvider();
  const runtime = new OperatorRuntime().register(provider);
  const first = new TaskOrchestrator({
    runtime, store: new TaskStore(state), permissions: permissions(root, ['file.read']), planners: [new OneStepPlanner()]
  });
  const second = new TaskOrchestrator({
    runtime, store: new TaskStore(state), permissions: permissions(root, ['file.read']), planners: [new OneStepPlanner()]
  });
  const task = await first.submit({
    objective: 'Execute exactly once.', authorizedScope: [root], successConditions: ['one execution'],
    goal: { kind: 'controlled-file-change', root, path: 'input.txt', content: 'unused' }
  });
  const running = first.run(task.id);
  await provider.startedPromise;
  await assert.rejects(
    () => second.run(task.id),
    (error: any) => error?.code === 'TASK_ALREADY_RUNNING'
  );
  provider.release();
  assert.equal((await running).state, 'VERIFIED');
  assert.equal((await new TaskStore(state).get(task.id)).execution?.records.length, 1);
});
