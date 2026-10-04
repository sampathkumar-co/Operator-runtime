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
import { ProjectTransactionProvider } from '../src/capabilities/project-transaction.ts';
import { classifyTaskFailure } from '../src/core/task-failure.ts';
import { createTask, addTaskNode, stableTaskNodeId } from '../src/core/task.ts';
import { TaskOrchestrator } from '../src/core/task-orchestrator.ts';
import { TaskStore } from '../src/core/task-store.ts';
import { verifyTaskCompletion } from '../src/core/task-verifier.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore, PermissionProfile } from '../src/core/types.ts';
import { supportedGitAvailable } from './git-test-support.ts';

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

test('stage3 failure taxonomy selects bounded autonomous strategies', () => {
  assert.deepEqual(classifyTaskFailure({ code: 'APPROVAL_REQUIRED', message: 'approval' }), {
    class: 'approval', strategy: 'block', retryable: false, code: 'APPROVAL_REQUIRED'
  });
  assert.equal(classifyTaskFailure({ code: 'DOCKER_STATE_CHANGED', message: 'stale', sideEffectState: 'none', executionPhase: 'pre_dispatch' }).strategy, 'reobserve');
  assert.equal(classifyTaskFailure({ code: 'DOCKER_STATE_CHANGED', message: 'stale', sideEffectState: 'none', executionPhase: 'dispatched' }).strategy, 'repair');
  assert.equal(classifyTaskFailure({ code: 'NETWORK_TIMEOUT', message: 'uncertain', retryable: true, sideEffectState: 'uncertain', executionPhase: 'dispatched' }).strategy, 'reconcile');
  assert.equal(classifyTaskFailure({ code: 'TARGET_EXISTS', message: 'drift' }).strategy, 'repair');
  assert.equal(classifyTaskFailure({ code: 'RELAY_RESULT_PENDING', message: 'pending', retryable: true }).strategy, 'retry');
  assert.equal(classifyTaskFailure({ code: 'PATH_OUTSIDE_SCOPE', message: 'policy' }).class, 'policy');
  for (const code of ['BROWSER_POSTCONDITION_FAILED', 'DOCKER_POSTCONDITION_FAILED', 'PROCESS_TERMINATE_POSTCONDITION_FAILED']) {
    assert.deepEqual(classifyTaskFailure({ code, message: 'verification failed', retryable: true, sideEffectState: 'uncertain' }), {
      class: 'postcondition', strategy: 'fail', retryable: false, code
    });
  }
  assert.equal(classifyTaskFailure({ code: 'PROJECT_ARTIFACT_MISMATCH', message: 'drift', sideEffectState: 'none' }).strategy, 'repair');
  assert.equal(classifyTaskFailure({ code: 'PROJECT_ARTIFACT_MISMATCH', message: 'unknown', sideEffectState: 'uncertain' }).strategy, 'fail');
});

test('stage3 graph node identity is stable across reconstruction and dependencies remain explicit', () => {
  const task = createTask({
    userObjective: 'stable graph',
    interpretedObjective: 'controlled-file-change:stable graph',
    authorizedScope: ['/tmp/project'],
    prohibitedScope: [],
    successConditions: ['graph is stable']
  });
  const first = addTaskNode(task, 'Inspect', { key: 'inspect' });
  const same = addTaskNode(task, 'Inspect renamed presentation', { key: 'inspect' });
  const second = addTaskNode(task, 'Mutate', { key: 'mutate', dependsOn: [first.id] });
  assert.equal(first.id, stableTaskNodeId(task.id, 'inspect'));
  assert.equal(same.id, first.id);
  assert.equal(second.id, stableTaskNodeId(task.id, 'mutate'));
  assert.deepEqual(second.dependsOn, [first.id]);
});

test('stage3 independent verifier rejects in-flight graph state and emits a stable evidence digest', () => {
  const task = createTask({
    userObjective: 'verify independently',
    interpretedObjective: 'controlled-file-change:verify independently',
    authorizedScope: ['/tmp/project'],
    prohibitedScope: [],
    successConditions: ['nothing remains in flight']
  });
  const node = addTaskNode(task, 'Inspect', { key: 'inspect' });
  node.state = 'RUNNING';
  task.execution = {
    schemaVersion: 1,
    plannerId: 'test',
    goalKind: 'controlled-file-change',
    plannerState: { phase: 'complete', goal: { kind: 'controlled-file-change' } },
    maxSteps: 5,
    maxAttemptsPerStep: 2,
    timeoutMs: 1000,
    stepCount: 1,
    records: [{
      stepKey: 'inspect',
      actionId: 'task-' + 'a'.repeat(64),
      capability: 'file.read',
      risk: 'read',
      inputHash: 'b'.repeat(64),
      attempt: 1,
      state: 'STARTED',
      startedAt: new Date().toISOString(),
      evidence: []
    }]
  };
  task.evidence.push({ kind: 'runtime', status: 'info', message: 'observed', timestamp: new Date().toISOString() });
  const verdict = verifyTaskCompletion(task);
  assert.equal(verdict.ok, false);
  assert.match(verdict.bundle.digest, /^[0-9a-f]{64}$/);
  assert.equal(verdict.evidence.status, 'fail');
  assert.ok(verdict.bundle.checks.some((check) => check.name === 'no-inflight-actions' && !check.ok));
});

test('independent typed outcome verification rejects planner completion when machine state is false', () => {
  const task = createTask({
    userObjective: 'prove exact content independently',
    interpretedObjective: 'controlled-file-change:prove exact content independently',
    authorizedScope: ['/tmp/project'],
    prohibitedScope: [],
    successConditions: ['exact requested content is present']
  });
  const node = addTaskNode(task, 'Verify file', { key: 'verify-file', stepKey: 'verify-file', actionId: 'task-' + 'd'.repeat(64) });
  node.state = 'VERIFIED';
  const expected = 'expected content\n';
  task.execution = {
    schemaVersion: 1,
    plannerId: 'operator.semantic.v1',
    goalKind: 'controlled-file-change',
    plannerState: {
      phase: 'complete',
      goal: { kind: 'controlled-file-change', root: '/tmp/project', path: '/tmp/project/a.txt', content: expected }
    },
    maxSteps: 5,
    maxAttemptsPerStep: 2,
    timeoutMs: 1000,
    stepCount: 1,
    dispatchedActions: 1,
    plannerIterations: 2,
    preDispatchReobserves: 0,
    records: [{
      stepKey: 'verify-file',
      actionId: 'task-' + 'd'.repeat(64),
      capability: 'file.read',
      risk: 'read',
      inputHash: 'e'.repeat(64),
      attempt: 1,
      state: 'SUCCEEDED',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      sideEffectState: 'none',
      executionPhase: 'effect_observed',
      observation: {
        schemaVersion: 2,
        channel: 'semantic',
        domain: 'filesystem',
        provider: 'test',
        capability: 'file.read',
        entityId: 'filesystem:test',
        observedAt: new Date().toISOString(),
        stateVersion: 'f'.repeat(64),
        importantState: { ok: true, sha256: crypto.createHash('sha256').update('wrong content\n').digest('hex') },
        ambiguous: false,
        confidence: 1,
        evidenceRefs: []
      },
      evidence: [{ kind: 'read', status: 'pass', message: 'read file', timestamp: new Date().toISOString() }]
    }]
  };

  const verdict = verifyTaskCompletion(task);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.bundle.checks.some((check) => check.name === 'typed-goal-outcome-truth' && !check.ok));
  assert.ok(verdict.bundle.checks.some((check) => check.name === 'declared-condition-1' && !check.ok));
});

test('stage3 repairs wrong existing file content with SHA precondition, explicit approval, and fresh verification', async (t) => {
  if (!supportedGitAvailable()) { t.skip('supported Git executable is unavailable'); return; }
  const root = await tempDir(t, 'operator-stage3-repair-root-');
  const state = await tempDir(t, 'operator-stage3-repair-state-');
  const target = path.join(root, 'repair.txt');
  await fs.writeFile(target, 'stale content\n');
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => execFile('git', ['init', '--quiet'], { cwd: root }, (error) => error ? reject(error) : resolve()));

  const runtime = new OperatorRuntime()
    .register(filesystem(root))
    .register(new GitProvider({ allowedRoots: [root] }));
  const orchestrator = new TaskOrchestrator({
    runtime,
    store: new TaskStore(state),
    permissions: permissions(root, ['file.list', 'file.create', 'file.read', 'file.replace', 'git.status'])
  });

  const submitted = await orchestrator.submit({
    objective: 'Make repair.txt exactly match the requested durable content.',
    authorizedScope: [root],
    successConditions: ['exact content is present', 'repair uses a fresh SHA precondition', 'Git observes the file'],
    goal: { kind: 'controlled-file-change', root, path: target, content: 'fresh content\n' }
  });

  const blocked = await orchestrator.run(submitted.id);
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(await fs.readFile(target, 'utf8'), 'stale content\n');
  const repair = blocked.execution!.records.find((record) => record.stepKey === 'repair-file');
  assert.ok(repair);
  assert.equal(repair!.capability, 'file.replace');
  assert.equal(repair!.state, 'BLOCKED');

  const completed = await orchestrator.resume(submitted.id, [repair!.actionId]);
  assert.equal(completed.state, 'VERIFIED');
  assert.equal(await fs.readFile(target, 'utf8'), 'fresh content\n');
  assert.ok(completed.evidence.some((item) => item.kind === 'strategy_repair'));
  assert.ok(completed.evidence.some((item) => item.kind === 'failure_classification'));
  assert.ok(completed.evidence.some((item) => item.kind === 'independent_task_verification' && item.status === 'pass'));
  assert.deepEqual(completed.nodes.map((node) => node.stepKey), ['list-parent', 'create-file', 'verify-file', 'repair-file', 'verify-file', 'inspect-git']);
  assert.equal(new Set(completed.nodes.map((node) => node.key)).size, completed.nodes.length);
  assert.equal(new Set(completed.nodes.map((node) => node.actionId)).size, completed.nodes.length);
  for (let index = 1; index < completed.nodes.length; index += 1) {
    assert.ok(completed.nodes[index]!.dependsOn.length <= 1);
  }
});

test('stage3 project quality goal compiles trusted lint/test/build checks at runtime', async (t) => {
  const root = await tempDir(t, 'operator-stage3-quality-root-');
  const authority = await tempDir(t, 'operator-stage3-quality-authority-');
  const state = await tempDir(t, 'operator-stage3-quality-state-');
  const registryPath = path.join(authority, 'commands.json');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'stage3-quality-fixture' }));
  const definitions = [
    { id: 'quality-lint', kind: 'lint', marker: 'lint.marker' },
    { id: 'quality-test', kind: 'test', marker: 'test.marker' },
    { id: 'quality-build', kind: 'build', marker: 'build.marker' }
  ] as const;
  await fs.writeFile(registryPath, JSON.stringify({
    version: 1,
    projects: [{
      root,
      commands: definitions.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        executable: 'node',
        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(root, entry.marker))},${JSON.stringify(entry.kind)})`],
        cwd: '.',
        risk: 'read',
        artifacts: [{ path: entry.marker, kind: 'file', minBytes: 1, mustChange: true }]
      }))
    }]
  }));

  const runtime = new OperatorRuntime()
    .register(new ProjectInspectProvider({ allowedRoots: [root] }))
    .register(new ProjectCommandProvider({ allowedRoots: [root], allowedExecutables: ['node'], registryPath }));
  const orchestrator = new TaskOrchestrator({
    runtime,
    store: new TaskStore(state),
    permissions: permissions(root, ['project.inspect', 'project.command.inspect', 'project.command.run'])
  });
  const submitted = await orchestrator.submit({
    objective: 'Prove project quality using only locally trusted commands.',
    authorizedScope: [root],
    successConditions: ['lint, test, and build trusted checks all pass'],
    goal: { kind: 'project-quality-gate', root, checks: ['lint', 'test', 'build'], requireAll: true }
  });
  const completed = await orchestrator.run(submitted.id);
  assert.equal(completed.state, 'VERIFIED');
  assert.deepEqual(completed.execution?.records.map((record) => record.capability), [
    'project.inspect', 'project.command.inspect', 'project.command.run', 'project.command.run', 'project.command.run'
  ]);
  assert.ok(completed.evidence.some((item) => item.kind === 'goal_compilation' && item.status === 'pass'));
  assert.ok(completed.evidence.some((item) => item.kind === 'independent_task_verification' && item.status === 'pass'));
});


test('stage3 crash recovery refreshes active deadline without resetting step or attempt history', async (t) => {
  if (!supportedGitAvailable()) { t.skip('supported Git executable is unavailable'); return; }
  const root = await tempDir(t, 'operator-stage3-restart-root-');
  const state = await tempDir(t, 'operator-stage3-restart-state-');
  const target = path.join(root, 'recovered.txt');
  const content = 'already applied before crash\n';
  await fs.writeFile(target, content);
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => execFile('git', ['init', '--quiet'], { cwd: root }, (error) => error ? reject(error) : resolve()));

  const store = new TaskStore(state);
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime().register(filesystem(root)).register(new GitProvider({ allowedRoots: [root] })),
    store,
    permissions: permissions(root, ['file.list', 'file.create', 'file.read', 'file.replace', 'git.status'])
  });
  const task = await orchestrator.submit({
    objective: 'Recover an interrupted file creation after process downtime.',
    authorizedScope: [root],
    successConditions: ['do not duplicate mutation', 'fresh verification succeeds after restart'],
    goal: { kind: 'controlled-file-change', root, path: target, content },
    // The persisted deadline below is intentionally expired. The active
    // recovery budget must be long enough that this test measures crash
    // recovery semantics rather than CI runner filesystem/Git latency.
    timeoutMs: 30_000
  });
  task.state = 'RUNNING';
  task.execution!.plannerState.phase = 'create';
  task.execution!.startedAt = new Date(Date.now() - 60_000).toISOString();
  task.execution!.deadlineAt = new Date(Date.now() - 30_000).toISOString();
  // Environment-action accounting is charged only once dispatch is known. The
  // interrupted STARTED record below is reconciled conservatively as dispatched.
  task.execution!.stepCount = 0;
  task.execution!.dispatchedActions = 0;
  task.execution!.plannerIterations = 1;
  const inputHash = crypto.createHash('sha256').update(JSON.stringify({ content, path: target })).digest('hex');
  task.execution!.records.push({
    stepKey: 'create-file',
    actionId: 'task-' + 'c'.repeat(64),
    capability: 'file.create',
    risk: 'write',
    inputHash,
    attempt: 1,
    state: 'STARTED',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    evidence: []
  });
  await store.put(task);

  const completed = await orchestrator.run(task.id);
  assert.equal(completed.state, 'VERIFIED');
  assert.equal(await fs.readFile(target, 'utf8'), content);
  assert.equal(completed.execution!.records[0]!.state, 'INTERRUPTED');
  assert.ok(Date.parse(completed.execution!.deadlineAt!) > Date.now(), 'recovery must refresh the active deadline into the future');
  assert.ok(completed.evidence.some((item) => item.kind === 'task_recovery'));
  assert.equal(completed.execution!.stepCount >= 1, true);
});

const STAGE3_SCORE: CapabilityScore = {
  reliability: 1, latency: 1, determinism: 1, security: 1,
  reversibility: 1, informationQuality: 1, interactionCost: 0
};

class RetryableWriteFailureProvider implements CapabilityProvider {
  readonly name = 'test.retryable-write-failure';
  calls = 0;
  supports(action: ActionRequest): boolean { return action.capability === 'file.create'; }
  score(): CapabilityScore { return STAGE3_SCORE; }
  async execute(action: ActionRequest): Promise<ActionResult> {
    this.calls += 1;
    return {
      ok: false,
      capability: action.capability,
      provider: this.name,
      evidence: [],
      error: { code: 'TEMPORARY_WRITE_FAILURE', message: 'uncertain write result', retryable: true },
      durationMs: 0
    };
  }
}

test('stage3 never blindly replays a retryable mutating action with uncertain side effects', async (t) => {
  const root = await tempDir(t, 'operator-stage3-no-write-replay-root-');
  const state = await tempDir(t, 'operator-stage3-no-write-replay-state-');
  const provider = new RetryableWriteFailureProvider();
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime().register(provider),
    store: new TaskStore(state),
    permissions: permissions(root, ['file.create'])
  });
  const task = await orchestrator.submit({
    objective: 'Fail closed rather than replay an uncertain write.',
    authorizedScope: [root],
    successConditions: ['write dispatch occurs at most once'],
    goal: { kind: 'controlled-file-change', root, path: path.join(root, 'uncertain.txt'), content: 'x' }
  });
  task.execution!.plannerState.phase = 'create';
  await new TaskStore(state).put(task);

  const blocked = await orchestrator.run(task.id);
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(provider.calls, 1);
  assert.equal(blocked.execution?.stepCount, 1);
  assert.equal(blocked.execution?.dispatchedActions, 1);
  assert.equal(blocked.execution?.records.at(-1)?.state, 'BLOCKED');
  assert.equal(blocked.execution?.records.at(-1)?.executionPhase, 'dispatched');
  assert.ok(blocked.evidence.some((item) => item.kind === 'strategy_reconcile'));
});

test('stage3 quality gate fails closed when a required trusted check is unavailable', async (t) => {
  const root = await tempDir(t, 'operator-stage3-quality-missing-root-');
  const authority = await tempDir(t, 'operator-stage3-quality-missing-authority-');
  const state = await tempDir(t, 'operator-stage3-quality-missing-state-');
  const registryPath = path.join(authority, 'commands.json');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'stage3-quality-missing' }));
  await fs.writeFile(registryPath, JSON.stringify({
    version: 1,
    projects: [{
      root,
      commands: [{
        id: 'only-test', kind: 'test', executable: 'node', args: ['-e', 'process.exit(0)'],
        cwd: '.', risk: 'read', artifacts: []
      }]
    }]
  }));
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime()
      .register(new ProjectInspectProvider({ allowedRoots: [root] }))
      .register(new ProjectCommandProvider({ allowedRoots: [root], allowedExecutables: ['node'], registryPath })),
    store: new TaskStore(state),
    permissions: permissions(root, ['project.inspect', 'project.command.inspect', 'project.command.run'])
  });
  const task = await orchestrator.submit({
    objective: 'Require both lint and test.',
    authorizedScope: [root],
    successConditions: ['all required checks must exist and pass'],
    goal: { kind: 'project-quality-gate', root, checks: ['lint', 'test'], requireAll: true }
  });
  const failed = await orchestrator.run(task.id);
  assert.equal(failed.state, 'FAILED');
  assert.match(failed.failures.at(-1)?.message ?? '', /lint/i);
  assert.equal(failed.execution!.records.some((record) => record.capability === 'project.command.run'), false);
  assert.ok(failed.evidence.some((item) => item.kind === 'goal_compilation' && item.status === 'fail'));
});


test('stage3 mutating quality check runs transactionally and rolls back false-green output', async (t) => {
  if (!supportedGitAvailable()) { t.skip('supported Git executable is unavailable'); return; }
  const root = await tempDir(t, 'operator-stage3-quality-rollback-root-');
  const authority = await tempDir(t, 'operator-stage3-quality-rollback-authority-');
  const state = await tempDir(t, 'operator-stage3-quality-rollback-state-');
  const registryPath = path.join(authority, 'commands.json');
  const { execFile } = await import('node:child_process');
  const git = (...args: string[]) => new Promise<void>((resolve, reject) =>
    execFile('git', args, { cwd: root }, (error) => error ? reject(error) : resolve())
  );
  await git('init', '--quiet');
  await git('config', 'user.name', 'Operator Stage3');
  await git('config', 'user.email', 'stage3@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'stage3-quality-rollback' }));
  await fs.writeFile(path.join(root, 'app.txt'), 'base\n');
  await git('add', 'package.json', 'app.txt');
  await git('commit', '-m', 'base');

  const script = [
    "const fs=require('fs')",
    "fs.writeFileSync('app.txt','broken-but-zero-exit\\n')",
    "process.stdout.write('looks-green')"
  ].join(';');
  await fs.writeFile(registryPath, JSON.stringify({
    version: 1,
    projects: [{
      root,
      commands: [{
        id: 'false-green-build',
        kind: 'build',
        executable: 'node',
        args: ['-e', script],
        cwd: '.',
        risk: 'write',
        artifacts: [{ path: 'required-report.json', kind: 'json', minBytes: 2, mustChange: true }]
      }]
    }]
  }));

  const runtime = new OperatorRuntime()
    .register(new ProjectInspectProvider({ allowedRoots: [root] }))
    .register(new ProjectCommandProvider({ allowedRoots: [root], allowedExecutables: ['node'], registryPath }))
    .register(new ProjectTransactionProvider({ allowedRoots: [root], allowedExecutables: ['node'], registryPath }));
  const orchestrator = new TaskOrchestrator({
    runtime,
    store: new TaskStore(state),
    permissions: permissions(root, ['project.inspect', 'project.command.inspect', 'project.command.run', 'project.transaction.run'])
  });
  const task = await orchestrator.submit({
    objective: 'Run the trusted build without leaving failed mutations behind.',
    authorizedScope: [root],
    successConditions: ['build artifacts verify', 'failed mutation is rolled back'],
    goal: { kind: 'project-quality-gate', root, checks: ['build'], requireAll: true }
  });

  const blocked = await orchestrator.run(task.id);
  assert.equal(blocked.state, 'BLOCKED');
  const transaction = blocked.execution!.records.find((record) => record.capability === 'project.transaction.run');
  assert.ok(transaction);
  const failed = await orchestrator.resume(task.id, [transaction!.actionId]);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.failures.at(-1)?.code, 'TRANSACTION_FAILED_GIT_STATE_RESTORED');
  assert.equal(await fs.readFile(path.join(root, 'app.txt'), 'utf8'), 'base\n');
  const status = await new Promise<string>((resolve, reject) =>
    execFile('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout))
  );
  assert.equal(status, '');
  assert.ok(failed.execution!.records.some((record) => record.capability === 'project.transaction.run' && record.state === 'FAILED'));
});


class Stage3AppFallbackProvider implements CapabilityProvider {
  readonly name = 'test.stage3-app-fallback';
  calls: string[] = [];
  supports(action: ActionRequest): boolean {
    return ['app.inspect', 'app.operate', 'visual.capture', 'input.operate'].includes(action.capability);
  }
  score(): CapabilityScore { return STAGE3_SCORE; }
  async execute(action: ActionRequest): Promise<ActionResult> {
    this.calls.push(action.capability);
    if (action.capability === 'app.inspect') {
      return {
        ok: false, capability: action.capability, provider: this.name, evidence: [],
        error: { code: 'UIA_ELEMENT_NOT_FOUND', message: 'semantic target unavailable', retryable: true }, durationMs: 0
      };
    }
    if (action.capability === 'visual.capture') {
      return {
        ok: true, capability: action.capability, provider: this.name, evidence: [],
        output: {
          captureId: 'capture-stage3-1', sha256: 'a'.repeat(64), source: 'screen',
          originX: 0, originY: 0, sourceWidth: 100, sourceHeight: 100,
          width: 100, height: 100, scaleX: 1, scaleY: 1, mimeType: 'image/png', imageBase64: 'iVBORw0KGgo='
        },
        durationMs: 0
      };
    }
    if (action.capability === 'input.operate') {
      return {
        ok: true, capability: action.capability, provider: this.name, evidence: [],
        output: {
          operation: 'click',
          before: { captureId: 'capture-stage3-1', sha256: 'a'.repeat(64) },
          after: { sha256: 'b'.repeat(64), changed: true },
          postcondition: {
            dispatched: true, captureLeaseConsumed: true, afterCaptured: true,
            afterSha256: 'b'.repeat(64), changed: true, windowStable: true
          }
        },
        durationMs: 0
      };
    }
    return {
      ok: false, capability: action.capability, provider: this.name, evidence: [],
      error: { code: 'UNEXPECTED_APP_OPERATION', message: 'semantic operate must not run after inspect fallback', retryable: false }, durationMs: 0
    };
  }
}

test('stage3 app goal falls back from failed semantic targeting to approved capture-bound physical input', async (t) => {
  const state = await tempDir(t, 'operator-stage3-app-fallback-state-');
  const root = await tempDir(t, 'operator-stage3-app-fallback-root-');
  const provider = new Stage3AppFallbackProvider();
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime().register(provider),
    store: new TaskStore(state),
    permissions: permissions(root, ['app.inspect', 'app.operate', 'visual.capture', 'input.operate'])
  });

  const task = await orchestrator.submit({
    objective: 'Focus the app target, using the explicitly bounded visual fallback only if semantic targeting is unavailable.',
    authorizedScope: [],
    successConditions: ['semantic targeting is attempted first', 'physical fallback uses a fresh capture lease', 'AFTER capture is verified'],
    goal: {
      kind: 'app-operation',
      operation: 'focus',
      selector: { automationId: 'missing-semantic-target' },
      physicalFallback: { source: 'screen', operation: 'click', x: 20, y: 30, maxWidth: 100, maxHeight: 100 }
    }
  });

  const blocked = await orchestrator.run(task.id);
  assert.equal(blocked.state, 'BLOCKED');
  const physical = blocked.execution!.records.find((record) => record.stepKey === 'operate-app-physical-fallback');
  assert.ok(physical);
  assert.equal(physical!.capability, 'input.operate');
  assert.equal(physical!.state, 'BLOCKED');
  assert.deepEqual(provider.calls, ['app.inspect', 'visual.capture']);

  const completed = await orchestrator.resume(task.id, [physical!.actionId]);
  assert.equal(completed.state, 'VERIFIED');
  assert.deepEqual(provider.calls, ['app.inspect', 'visual.capture', 'input.operate']);
  assert.equal(completed.execution!.plannerState.phase, 'physical-complete');
  assert.ok(completed.evidence.some((item) => item.kind === 'strategy_fallback'));
  assert.ok(completed.evidence.some((item) => item.kind === 'independent_task_verification' && item.status === 'pass'));
  const captureRecord = completed.execution!.records.find((record) => record.stepKey === 'capture-app-fallback');
  assert.equal(captureRecord?.observation?.schemaVersion, 2);
  assert.equal(captureRecord?.observation?.channel, 'visual');
  const physicalRecord = completed.execution!.records.find((record) => record.stepKey === 'operate-app-physical-fallback');
  assert.equal(physicalRecord?.observation?.channel, 'visual');
  assert.equal((physicalRecord?.observation?.importantState.postcondition as any)?.afterCaptured, true);
});


class Stage3StaleVisualProvider implements CapabilityProvider {
  readonly name = 'test.stage3-stale-visual';
  visualCount = 0;
  physicalCount = 0;
  supports(action: ActionRequest): boolean {
    return ['app.inspect', 'visual.capture', 'input.operate'].includes(action.capability);
  }
  score(): CapabilityScore { return STAGE3_SCORE; }
  async execute(action: ActionRequest): Promise<ActionResult> {
    if (action.capability === 'app.inspect') {
      return {
        ok: false, capability: action.capability, provider: this.name, evidence: [],
        error: { code: 'UIA_ELEMENT_NOT_FOUND', message: 'semantic target unavailable', retryable: true }, durationMs: 0
      };
    }
    if (action.capability === 'visual.capture') {
      this.visualCount += 1;
      const digit = this.visualCount === 1 ? 'a' : 'c';
      return {
        ok: true, capability: action.capability, provider: this.name, evidence: [],
        output: {
          captureId: `capture-${this.visualCount}`, sha256: digit.repeat(64), source: 'screen',
          originX: 0, originY: 0, sourceWidth: 80, sourceHeight: 80,
          width: 80, height: 80, scaleX: 1, scaleY: 1, mimeType: 'image/png', imageBase64: 'iVBORw0KGgo='
        }, durationMs: 0
      };
    }
    this.physicalCount += 1;
    if (this.physicalCount === 1) {
      return {
        ok: false, capability: action.capability, provider: this.name, evidence: [],
        error: { code: 'INPUT_CAPTURE_STALE', message: 'pixels changed before dispatch', retryable: true }, durationMs: 0
      };
    }
    return {
      ok: true, capability: action.capability, provider: this.name, evidence: [],
      output: {
        operation: 'click',
        postcondition: {
          dispatched: true, captureLeaseConsumed: true, afterCaptured: true,
          afterSha256: 'd'.repeat(64), changed: true, windowStable: true
        }
      }, durationMs: 0
    };
  }
}

test('stage3 stale visual state forces recapture and a new approval-bound physical action identity', async (t) => {
  const state = await tempDir(t, 'operator-stage3-stale-visual-state-');
  const provider = new Stage3StaleVisualProvider();
  const orchestrator = new TaskOrchestrator({
    runtime: new OperatorRuntime().register(provider),
    store: new TaskStore(state),
    permissions: permissions(state, ['app.inspect', 'visual.capture', 'input.operate'])
  });
  const submitted = await orchestrator.submit({
    objective: 'Use bounded visual fallback without clicking stale pixels.',
    authorizedScope: [],
    successConditions: ['stale pixels are never clicked', 'fresh capture creates a new approval identity'],
    goal: {
      kind: 'app-operation',
      operation: 'focus',
      selector: { automationId: 'missing-target' },
      physicalFallback: { source: 'screen', operation: 'click', x: 12, y: 16, maxWidth: 80, maxHeight: 80 }
    },
    maxAttemptsPerStep: 3
  });

  const firstBlocked = await orchestrator.run(submitted.id);
  const firstPhysical = firstBlocked.execution!.records.find((record) => record.stepKey === 'operate-app-physical-fallback' && record.state === 'BLOCKED');
  assert.ok(firstPhysical);

  const secondBlocked = await orchestrator.resume(submitted.id, [firstPhysical!.actionId]);
  assert.equal(secondBlocked.state, 'BLOCKED');
  assert.equal(provider.physicalCount, 1);
  assert.equal(provider.visualCount, 2);
  const physicalRecords = secondBlocked.execution!.records.filter((record) => record.stepKey === 'operate-app-physical-fallback');
  assert.equal(physicalRecords.length, 2);
  const secondPhysical = physicalRecords.find((record) => record.state === 'BLOCKED');
  assert.ok(secondPhysical);
  assert.notEqual(secondPhysical!.actionId, firstPhysical!.actionId);
  assert.ok(secondBlocked.evidence.some((item) => item.kind === 'strategy_fallback' && /stale lease/i.test(item.message)));

  const completed = await orchestrator.resume(submitted.id, [secondPhysical!.actionId]);
  assert.equal(completed.state, 'VERIFIED');
  assert.equal(provider.physicalCount, 2);
  assert.ok(completed.evidence.some((item) => item.kind === 'independent_task_verification' && item.status === 'pass'));
});
