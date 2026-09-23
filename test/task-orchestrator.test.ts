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
  assert.ok(completed.execution?.records.every((record) => record.observation?.schemaVersion === 2));
  assert.ok(completed.execution?.records.every((record) => record.observation?.entityId?.match(/^[a-z]+:[0-9a-f]{32}$/)));
  assert.ok(completed.execution?.records.every((record) => record.observation?.stateVersion?.match(/^[0-9a-f]{64}$/)));
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

class SemanticBrowserProvider implements CapabilityProvider {
  readonly name = 'test.browser.semantic';
  #url = 'https://example.test/start';
  supports(action: ActionRequest): boolean { return ['browser.inspect', 'browser.navigate'].includes(action.capability); }
  score(): CapabilityScore { return SCORE; }
  async execute(action: ActionRequest): Promise<ActionResult> {
    if (action.capability === 'browser.navigate') {
      assert.equal(action.input.targetId, 'tab-1');
      this.#url = String(action.input.url);
      return {
        ok: true, capability: action.capability, provider: this.name,
        output: { targetId: 'tab-1', url: this.#url, title: 'Destination' }, evidence: [], durationMs: 0
      };
    }
    return {
      ok: true, capability: action.capability, provider: this.name,
      output: action.input.targetId
        ? { target: { id: 'tab-1', type: 'page', title: 'Destination', url: this.#url }, page: { semantic: { headings: ['Destination'] } } }
        : { tabs: [{ id: 'tab-1', type: 'page', title: 'Start', url: this.#url }] },
      evidence: [], durationMs: 0
    };
  }
}

test('task executor navigates and re-observes a semantic browser target before completion', async (t) => {
  const state = await tempDir(t, 'operator-task-browser-state-');
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime().register(new SemanticBrowserProvider()),
    store: new TaskStore(state),
    permissions: {
      allowedCapabilities: ['browser.inspect', 'browser.navigate'], allowedRoots: [],
      allowDestructive: false, allowExternalWrites: false, allowSystemChanges: false
    }
  });
  const task = await orchestrator.submit({
    objective: 'Navigate a semantic browser page and verify the destination.',
    authorizedScope: ['browser:https://example.test'],
    successConditions: ['selected page reaches requested destination', 'semantic re-observation confirms it'],
    goal: { kind: 'browser-navigation', url: 'https://example.test/destination?mode=verified#section' }
  });

  const completed = await orchestrator.run(task.id);
  assert.equal(completed.state, 'VERIFIED');
  assert.deepEqual(completed.execution?.records.map((record) => record.capability), [
    'browser.inspect', 'browser.navigate', 'browser.inspect'
  ]);
  assert.ok(completed.execution?.records.every((record) => record.observation?.domain === 'browser'));
  assert.equal(completed.execution?.plannerState.targetId, 'tab-1');
});

class RediscoveringBrowserProvider implements CapabilityProvider {
  readonly name = 'test.browser.rediscovery';
  #targetId = 'tab-old';
  #url = 'https://example.test/start';
  #failedOnce = false;
  supports(action: ActionRequest): boolean { return ['browser.inspect', 'browser.navigate'].includes(action.capability); }
  score(): CapabilityScore { return SCORE; }
  async execute(action: ActionRequest): Promise<ActionResult> {
    if (action.capability === 'browser.navigate' && !this.#failedOnce) {
      this.#failedOnce = true;
      this.#targetId = 'tab-new';
      return {
        ok: false, capability: action.capability, provider: this.name, evidence: [], durationMs: 0,
        error: { code: 'BROWSER_TARGET_NOT_FOUND', message: 'Target closed.', retryable: true }
      };
    }
    if (action.capability === 'browser.navigate') {
      assert.equal(action.input.targetId, 'tab-new');
      this.#url = String(action.input.url);
      return { ok: true, capability: action.capability, provider: this.name, output: { targetId: this.#targetId, url: this.#url }, evidence: [], durationMs: 0 };
    }
    const output = action.input.targetId
      ? { target: { id: this.#targetId, type: 'page', url: this.#url } }
      : { tabs: [{ id: this.#targetId, type: 'page', url: this.#url }] };
    return { ok: true, capability: action.capability, provider: this.name, output, evidence: [], durationMs: 0 };
  }
}

test('browser task re-discovers a disappeared semantic target before retrying navigation', async (t) => {
  const state = await tempDir(t, 'operator-task-browser-fallback-');
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime().register(new RediscoveringBrowserProvider()), store: new TaskStore(state),
    permissions: { allowedCapabilities: ['browser.inspect', 'browser.navigate'], allowedRoots: [] }
  });
  const task = await orchestrator.submit({
    objective: 'Recover from a closed browser tab.', authorizedScope: ['browser:https://example.test'],
    successConditions: ['new page target reaches destination'],
    goal: { kind: 'browser-navigation', url: 'https://example.test/recovered' }
  });
  const completed = await orchestrator.run(task.id);
  assert.equal(completed.state, 'VERIFIED');
  assert.equal(completed.execution?.plannerState.targetId, 'tab-new');
  assert.equal(completed.execution?.records.find((record) => record.errorCode === 'BROWSER_TARGET_NOT_FOUND')?.state, 'FAILED');
  assert.ok(completed.evidence.some((item) => item.kind === 'strategy_fallback' && /re-discovery/.test(item.message)));
});

class SemanticDockerProvider implements CapabilityProvider {
  readonly name = 'test.docker.semantic';
  state: 'running' | 'exited' = 'running';
  manageCalls = 0;
  failStateChangedOnce = false;
  #failed = false;

  supports(action: ActionRequest): boolean { return ['docker.inspect', 'docker.manage'].includes(action.capability); }
  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const fingerprint = crypto.createHash('sha256').update(this.state).digest('hex');
    if (action.capability === 'docker.inspect') {
      return {
        ok: true, capability: action.capability, provider: this.name,
        output: {
          scope: 'project', fingerprint,
          services: [{ service: 'web', containers: 1, states: [this.state] }]
        },
        evidence: [], durationMs: 0
      };
    }
    this.manageCalls += 1;
    if (this.failStateChangedOnce && !this.#failed) {
      this.#failed = true;
      this.state = 'exited';
      return {
        ok: false, capability: action.capability, provider: this.name, evidence: [], durationMs: 0,
        error: { code: 'DOCKER_STATE_CHANGED', message: 'state changed after inspection', retryable: true }
      };
    }
    assert.equal(action.input.expectedCurrentFingerprint, fingerprint);
    assert.deepEqual(action.input.services, ['web']);
    assert.equal(action.input.operation, 'stop');
    this.state = 'exited';
    const afterFingerprint = crypto.createHash('sha256').update(this.state).digest('hex');
    return {
      ok: true, capability: action.capability, provider: this.name,
      output: {
        operation: 'stop', beforeFingerprint: fingerprint, afterFingerprint,
        states: [{ service: 'web', containers: 1, states: ['exited'] }]
      },
      evidence: [], durationMs: 0
    };
  }
}

class SemanticAppProvider implements CapabilityProvider {
  readonly name = 'test.windows.uia';
  value = 'before';
  operateCalls = 0;
  ambiguous = false;
  supports(action: ActionRequest): boolean { return ['app.inspect', 'app.operate'].includes(action.capability); }
  score(): CapabilityScore { return SCORE; }
  async execute(action: ActionRequest): Promise<ActionResult> {
    if (action.capability === 'app.operate') {
      this.operateCalls += 1;
      assert.equal(action.input.operation, 'set_value');
      assert.deepEqual(action.input.selector, { automationId: 'editor-value', controlType: 'Edit' });
      this.value = String(action.input.value);
      return {
        ok: true, capability: action.capability, provider: this.name,
        output: { operation: 'set_value', postcondition: { verified: true, actual_value: this.value } },
        evidence: [], durationMs: 0
      };
    }
    if (this.ambiguous) return {
      ok: false, capability: action.capability, provider: this.name, evidence: [], durationMs: 0,
      error: { code: 'UIA_AMBIGUOUS_SELECTOR', message: 'Selector matched more than one control.', retryable: false }
    };
    return {
      ok: true, capability: action.capability, provider: this.name,
      output: { elements: [{
        name: 'Editor value', automation_id: 'editor-value', class_name: 'TextBox', control_type: 'Edit', process_id: 4242,
        patterns: { invoke: false, value: true, selection_item: false, expand_collapse: false, scroll: false, legacy_iaccessible: false },
        value: this.value
      }] },
      evidence: [], durationMs: 0
    };
  }
}

test('docker lifecycle task uses fresh fingerprint, exact approval, and semantic re-inspection', async (t) => {
  const root = await tempDir(t, 'operator-task-docker-root-');
  const state = await tempDir(t, 'operator-task-docker-state-');
  const provider = new SemanticDockerProvider();
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime().register(provider), store: new TaskStore(state),
    permissions: {
      allowedCapabilities: ['docker.inspect', 'docker.manage'], allowedRoots: [root],
      allowDestructive: false, allowExternalWrites: false, allowSystemChanges: false
    }
  });
  const task = await orchestrator.submit({
    objective: 'Stop the existing web service and verify it is stopped.',
    authorizedScope: [root], successConditions: ['fresh Docker state is inspected', 'web is exited after approved stop'],
    goal: { kind: 'docker-lifecycle', root, operation: 'stop', services: ['web'] }
  });

  const blocked = await orchestrator.run(task.id);
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(provider.manageCalls, 0);
  assert.deepEqual(blocked.execution?.records.map((record) => record.capability), ['docker.inspect', 'docker.manage']);
  const actionId = blocked.execution!.records[1]!.actionId;

  const completed = await orchestrator.resume(task.id, [actionId]);
  assert.equal(completed.state, 'VERIFIED');
  assert.equal(provider.manageCalls, 1);
  assert.equal(provider.state, 'exited');
  assert.deepEqual(completed.execution?.records.map((record) => record.capability), ['docker.inspect', 'docker.manage', 'docker.inspect']);
  assert.ok(completed.execution?.records.every((record) => record.observation?.domain === 'docker'));
});

test('docker state race forces re-inspection and a new approval identity before retry', async (t) => {
  const root = await tempDir(t, 'operator-task-docker-race-root-');
  const state = await tempDir(t, 'operator-task-docker-race-state-');
  const provider = new SemanticDockerProvider();
  provider.failStateChangedOnce = true;
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime().register(provider), store: new TaskStore(state),
    permissions: {
      allowedCapabilities: ['docker.inspect', 'docker.manage'], allowedRoots: [root],
      allowDestructive: false, allowExternalWrites: false, allowSystemChanges: false
    }
  });
  const task = await orchestrator.submit({
    objective: 'Stop web without acting on stale Docker state.',
    authorizedScope: [root], successConditions: ['stale fingerprint is never reused', 'fresh approval is required after state change'],
    goal: { kind: 'docker-lifecycle', root, operation: 'stop', services: ['web'] }
  });

  const firstBlocked = await orchestrator.run(task.id);
  const firstApprovalId = firstBlocked.execution!.records.at(-1)!.actionId;
  const secondBlocked = await orchestrator.resume(task.id, [firstApprovalId]);
  assert.equal(secondBlocked.state, 'BLOCKED');
  assert.equal(provider.manageCalls, 1);
  const manageRecords = secondBlocked.execution!.records.filter((record) => record.capability === 'docker.manage');
  assert.equal(manageRecords.length, 2);
  assert.equal(manageRecords[0]!.errorCode, 'DOCKER_STATE_CHANGED');
  assert.notEqual(manageRecords[0]!.actionId, manageRecords[1]!.actionId);
  assert.ok(secondBlocked.evidence.some((item) => item.kind === 'strategy_fallback' && /fresh inspection/.test(item.message)));

  const completed = await orchestrator.resume(task.id, [manageRecords[1]!.actionId]);
  assert.equal(completed.state, 'VERIFIED');
  assert.equal(provider.manageCalls, 2);
});

test('app task inspects a unique UIA target, blocks for approval, operates once, and re-inspects the postcondition', async (t) => {
  const state = await tempDir(t, 'operator-task-app-state-');
  const provider = new SemanticAppProvider();
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime().register(provider), store: new TaskStore(state),
    permissions: {
      allowedCapabilities: ['app.inspect', 'app.operate'], allowedRoots: [],
      allowDestructive: false, allowExternalWrites: false, allowSystemChanges: false
    }
  });
  const task = await orchestrator.submit({
    objective: 'Set a semantic application value and verify it.', authorizedScope: ['app:editor-value'],
    successConditions: ['target is unique', 'approved mutation runs once', 're-inspection confirms exact value'],
    goal: { kind: 'app-operation', operation: 'set_value', selector: { automationId: 'editor-value', controlType: 'Edit' }, value: 'after' }
  });

  const blocked = await orchestrator.run(task.id);
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(provider.operateCalls, 0);
  assert.deepEqual(blocked.execution?.records.map((record) => record.capability), ['app.inspect', 'app.operate']);
  const actionId = blocked.execution!.records[1]!.actionId;

  const completed = await orchestrator.resume(task.id, [actionId]);
  assert.equal(completed.state, 'VERIFIED');
  assert.equal(provider.operateCalls, 1);
  assert.equal(provider.value, 'after');
  assert.deepEqual(completed.execution?.records.map((record) => record.capability), ['app.inspect', 'app.operate', 'app.inspect']);
  assert.ok(completed.execution?.records.every((record) => record.observation?.domain === 'uia'));
  assert.equal(completed.execution?.records[1]?.actionId, actionId);
});

test('app task fails closed on an ambiguous semantic selector without operating any control', async (t) => {
  const state = await tempDir(t, 'operator-task-app-ambiguous-');
  const provider = new SemanticAppProvider();
  provider.ambiguous = true;
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime().register(provider), store: new TaskStore(state),
    permissions: { allowedCapabilities: ['app.inspect', 'app.operate'], allowedRoots: [], allowExternalWrites: true }
  });
  const task = await orchestrator.submit({
    objective: 'Never choose an ambiguous control.', authorizedScope: ['app:editor-value'], successConditions: ['fail closed'],
    goal: { kind: 'app-operation', operation: 'set_value', selector: { name: 'Editor value' }, value: 'unsafe' }
  });
  const failed = await orchestrator.run(task.id);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.failures.at(-1)?.code, 'UIA_AMBIGUOUS_SELECTOR');
  assert.equal(provider.operateCalls, 0);
  assert.deepEqual(failed.execution?.records.map((record) => record.capability), ['app.inspect']);
});

test('invoke app goals require an explicit semantic verification target', async (t) => {
  const state = await tempDir(t, 'operator-task-app-invoke-');
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime(), store: new TaskStore(state),
    permissions: { allowedCapabilities: ['app.inspect', 'app.operate'], allowedRoots: [] }
  });
  await assert.rejects(
    () => orchestrator.submit({
      objective: 'Invoke a control.', authorizedScope: ['app:save'], successConditions: ['verify side effect'],
      goal: { kind: 'app-operation', operation: 'invoke', selector: { automationId: 'save' } }
    }),
    (error: any) => error?.code === 'TASK_GOAL_INVALID'
  );
});

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
