import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/core/artifact-store.ts';
import {
  createDeveloperSession,
  DeveloperSessionStore,
  updateDeveloperSession
} from '../src/core/developer-session.ts';
import { DeveloperSessionReviewCoordinator } from '../src/core/developer-session-review.ts';
import { DeveloperVerificationCoordinator } from '../src/core/developer-verification.ts';
import { DeveloperWorktreeManager } from '../src/core/developer-worktree.ts';
import {
  assertDeveloperEditWorkflowCoverage,
  createDeveloperEditWorkflow
} from '../src/core/developer-edit-workflow.ts';
import { createMultiFileEditPlan } from '../src/core/multi-file-edit-plan.ts';
import { createWorkspaceGraph } from '../src/core/workspace-graph.ts';
import { WorkspaceCodeIndexer } from '../src/core/workspace-code-index.ts';
import { WorkspaceSemanticIntelligence } from '../src/core/workspace-semantic-intelligence.ts';
import { WorkspaceEditTransactionProvider } from '../src/capabilities/workspace-edit-transaction.ts';
import { WorkspaceEditRollbackProvider } from '../src/capabilities/workspace-edit-rollback.ts';
import { resolveSupportedGitExecutable } from '../src/core/trusted-executable.ts';
import type { ActionRequest, ActionResult } from '../src/core/types.ts';
import { supportedGitAvailable } from './git-test-support.ts';

function sha(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function trustedCommandAction(commandId: string): ActionRequest {
  return {
    id: 'r3-e2e-' + commandId,
    capability: 'project.command.run',
    risk: 'read',
    input: { commandId, expectedRisk: 'read', path: '/workspace' },
    provenance: { kind: 'trusted_policy', source: 'r3-e2e' }
  };
}

function trustedCommandResult(commandId: string): ActionResult {
  return {
    ok: true,
    capability: 'project.command.run',
    provider: 'project.command.trusted',
    output: {
      command: { id: commandId },
      execution: { exitCode: 0, stdout: 'not persisted by verification coordinator', stderr: '' }
    },
    evidence: [{
      kind: 'command_registry',
      status: 'pass',
      message: 'Trusted registry command executed.',
      timestamp: '2026-10-06T00:10:00.000Z'
    }],
    durationMs: 10
  };
}

test('R3 exit gate: objective survives restart, edits, rollback, verification and external review', async (t) => {
  if (!supportedGitAvailable()) {
    t.skip('supported Git unavailable');
    return;
  }

  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-r3-exit-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const repo = path.join(parent, 'repo');
  const worktreeRoot = path.join(parent, 'worktrees');
  const stateDir = path.join(parent, 'state');
  await fs.mkdir(repo);
  await fs.mkdir(stateDir);

  const git = resolveSupportedGitExecutable(process.env);
  const runGit = (args: string[], cwd = repo) => {
    const result = spawnSync(git, args, {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        SYSTEMROOT: process.env.SYSTEMROOT,
        WINDIR: process.env.WINDIR,
        GIT_CONFIG_NOSYSTEM: '1'
      }
    });
    assert.equal(result.status, 0, String(result.stderr));
    return String(result.stdout).trim();
  };

  runGit(['init']);
  runGit(['config', 'user.email', 'r3@example.invalid']);
  runGit(['config', 'user.name', 'R3 Tests']);
  await fs.mkdir(path.join(repo, 'src'));
  await fs.mkdir(path.join(repo, 'test'));
  const before = [
    'export function value() {',
    '  return 1;',
    '}',
    ''
  ].join('\n');
  await fs.writeFile(path.join(repo, 'src', 'value.ts'), before);
  await fs.writeFile(path.join(repo, 'test', 'value.test.ts'), [
    "import { value } from '../src/value';",
    'export function valueTest() { return value() === 2; }',
    ''
  ].join('\n'));
  runGit(['add', '--', 'src/value.ts', 'test/value.test.ts']);
  runGit(['commit', '-m', 'base']);
  const baseCommit = runGit(['rev-parse', 'HEAD']);

  const sessionSeed = createDeveloperSession({
    objective: 'Change value() from 1 to 2 with verified rollback and review.',
    acceptanceCriteria: [
      'Type checking passes.',
      'Affected unit test passes.'
    ],
    constraints: ['No unrelated files.'],
    workspaceRootNodeId: 'workspace:r3',
    now: '2026-10-06T00:00:00.000Z'
  });

  const worktrees = new DeveloperWorktreeManager({
    allowedRepositoryRoots: [repo],
    worktreeRoot,
    stateDir
  });
  const worktree = await worktrees.create({
    sessionId: sessionSeed.id,
    repositoryRoot: repo,
    baseCommit
  });
  assert.equal(worktree.record.phase, 'ACTIVE');
  assert.ok(worktree.fingerprint);

  const indexer = new WorkspaceCodeIndexer(worktree.record.worktreePath, {
    clock: () => new Date('2026-10-06T00:01:00.000Z')
  });
  const index = await indexer.build();
  const semantic = await new WorkspaceSemanticIntelligence(worktree.record.worktreePath).build(index);
  const valueNode = semantic.nodes.find((node) => node.name === 'value');
  assert.ok(valueNode);

  const graph = createWorkspaceGraph({
    rootNodeId: 'workspace:r3',
    observedAt: '2026-10-06T00:01:30.000Z',
    nodes: [
      { id: 'workspace:r3', kind: 'workspace', label: 'R3 exit objective', metadata: {} },
      { id: 'repo:r3', kind: 'repository', label: 'fixture', revision: baseCommit, metadata: {} },
      { id: 'worktree:r3', kind: 'worktree', label: worktree.record.worktreePath, revision: baseCommit, metadata: {} },
      { id: 'file:value', kind: 'file', label: 'src/value.ts', revision: index.files.find((f) => f.path === 'src/value.ts')!.digest, metadata: {} },
      { id: 'symbol:value', kind: 'symbol', label: 'value', revision: valueNode!.id, metadata: {} },
      { id: 'test:value', kind: 'test', label: 'test/value.test.ts', metadata: {} }
    ],
    edges: [
      { from: 'workspace:r3', to: 'repo:r3', kind: 'contains', metadata: {} },
      { from: 'repo:r3', to: 'worktree:r3', kind: 'contains', metadata: {} },
      { from: 'worktree:r3', to: 'file:value', kind: 'contains', metadata: {} },
      { from: 'file:value', to: 'symbol:value', kind: 'contains', metadata: {} },
      { from: 'test:value', to: 'file:value', kind: 'verifies', metadata: {} }
    ]
  });

  const artifacts = new ArtifactStore(stateDir);
  const semanticArtifact = await artifacts.put({
    bytes: JSON.stringify({ indexId: index.id, semanticId: semantic.id }),
    kind: 'review-summary',
    mediaType: 'application/json',
    privacy: 'internal'
  });

  const sessions = new DeveloperSessionStore(stateDir);
  const active = updateDeveloperSession(sessionSeed, {
    status: 'ACTIVE',
    workspaceGraphId: graph.id,
    artifactIds: [semanticArtifact.id],
    activeResourceKeys: ['fs-path:' + worktree.record.worktreePath.replace(/\\/g, '/')]
  }, '2026-10-06T00:02:00.000Z');
  await sessions.put(active);

  const pauseCoordinator = new DeveloperSessionReviewCoordinator(stateDir);
  const paused = await pauseCoordinator.pause({
    sessionId: active.id,
    resumeSummary: 'Worktree and semantic snapshot are ready; apply transactional edit next.',
    now: '2026-10-06T00:03:00.000Z'
  });
  assert.equal(paused.session.status, 'PAUSED');

  const restartedReview = new DeveloperSessionReviewCoordinator(stateDir);
  const resumed = await restartedReview.resume({
    sessionId: active.id,
    resumeManifestArtifactId: paused.artifactId,
    now: '2026-10-06T00:04:00.000Z'
  });
  assert.equal(resumed.session.status, 'ACTIVE');

  const target = path.join(worktree.record.worktreePath, 'src', 'value.ts');
  const plan = createMultiFileEditPlan({
    files: [{
      path: 'src/value.ts',
      expectedSha256: sha(before),
      edits: [{
        start: before.indexOf('1'),
        end: before.indexOf('1') + 1,
        replacement: '2'
      }]
    }],
    verification: {
      trustedCommandIds: ['typecheck', 'unit-tests'],
      requiredTestPaths: ['test/value.test.ts']
    }
  });
  const workflow = createDeveloperEditWorkflow({
    editPlan: plan,
    postEditCommands: [{
      commandId: 'format-imports',
      roles: ['format', 'organize-imports']
    }]
  });

  const editProvider = new WorkspaceEditTransactionProvider({
    allowedRoots: [worktree.record.worktreePath],
    stateDir
  });
  const firstEdit: ActionRequest = {
    id: 'r3-e2e-edit-first',
    capability: 'workspace.edit.transaction',
    risk: 'write',
    input: {
      workspaceRoot: worktree.record.worktreePath,
      plan,
      retainRollback: true
    },
    provenance: { kind: 'runtime' }
  };
  const firstApplied = await editProvider.execute(firstEdit);
  assert.equal(firstApplied.ok, true);
  assert.match(await fs.readFile(target, 'utf8'), /return 2/);
  const firstRollbackArtifactId = String((firstApplied.output as Record<string, unknown>).rollbackArtifactId ?? '');
  assert.match(firstRollbackArtifactId, /^[0-9a-f]{64}$/);

  const rollbackProvider = new WorkspaceEditRollbackProvider({
    allowedRoots: [worktree.record.worktreePath],
    stateDir
  });
  const rolledBack = await rollbackProvider.execute({
    id: 'r3-e2e-rollback-first',
    capability: 'workspace.edit.rollback',
    risk: 'destructive',
    input: {
      workspaceRoot: worktree.record.worktreePath,
      rollbackArtifactId: firstRollbackArtifactId
    },
    provenance: { kind: 'runtime' }
  });
  assert.equal(rolledBack.ok, true);
  assert.equal(await fs.readFile(target, 'utf8'), before);

  const secondApplied = await editProvider.execute({
    ...firstEdit,
    id: 'r3-e2e-edit-final'
  });
  assert.equal(secondApplied.ok, true);
  assert.match(await fs.readFile(target, 'utf8'), /return 2/);

  assertDeveloperEditWorkflowCoverage(workflow, {
    appliedPlanId: plan.id,
    successfulPostEditCommandIds: ['format-imports'],
    successfulVerificationCommandIds: ['typecheck', 'unit-tests'],
    observedTestPaths: ['test/value.test.ts']
  });

  const verification = new DeveloperVerificationCoordinator(stateDir);
  const run = await verification.start({
    developerSessionId: active.id,
    requirements: [
      { commandId: 'typecheck', criterionIndexes: [0] },
      { commandId: 'unit-tests', criterionIndexes: [1] }
    ],
    now: '2026-10-06T00:08:00.000Z'
  });
  for (const commandId of ['typecheck', 'unit-tests']) {
    await verification.recordAuthorizedCommandResult({
      runId: run.run.id,
      action: trustedCommandAction(commandId),
      result: trustedCommandResult(commandId),
      executionContext: { schemaVersion: 1, sessionId: active.id },
      now: commandId === 'typecheck'
        ? '2026-10-06T00:09:00.000Z'
        : '2026-10-06T00:10:00.000Z'
    });
  }
  const verified = await verification.finalize(
    run.run.id,
    '2026-10-06T00:11:00.000Z'
  );
  assert.equal(verified.verified, true);
  assert.equal(verified.session.status, 'COMPLETED');
  assert.ok(verified.evidencePackArtifactId);

  const external = await new DeveloperSessionReviewCoordinator(stateDir).publishExternalReview({
    sessionId: active.id,
    evidencePackArtifactId: verified.evidencePackArtifactId,
    resumeManifestArtifactId: paused.artifactId,
    now: '2026-10-06T00:12:00.000Z'
  });
  assert.match(external.summary.id, /^[0-9a-f]{64}$/);
  assert.equal(external.summary.evidencePackArtifactId, verified.evidencePackArtifactId);
  assert.equal(external.summary.resumeManifestArtifactId, paused.artifactId);
  const reviewArtifact = await artifacts.read(external.artifactId);
  assert.equal(reviewArtifact.record.kind, 'review-summary');
  assert.equal(reviewArtifact.record.metadata.reviewType, 'developer-external-review');
});
