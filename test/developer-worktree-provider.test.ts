import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { DeveloperWorktreeProvider } from '../src/capabilities/developer-worktree.ts';
import {
  createDeveloperSession,
  DeveloperSessionStore,
  updateDeveloperSession
} from '../src/core/developer-session.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import type { ActionRequest, PermissionProfile } from '../src/core/types.ts';
import { supportedGitAvailable } from './git-test-support.ts';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_GLOBAL: nullConfig,
      GIT_CONFIG_SYSTEM: nullConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_NO_LAZY_FETCH: '1'
    }
  });
  return String(result.stdout ?? '').trim();
}

async function fixture(t: test.TestContext) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-worktree-provider-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const repo = path.join(parent, 'repo');
  const stateDir = path.join(parent, 'state');
  const worktreeRoot = path.join(parent, 'worktrees');
  await fs.mkdir(repo);
  await git(repo, ['init']);
  await git(repo, ['config', 'user.name', 'Mecord Test']);
  await git(repo, ['config', 'user.email', 'mecord-test@local.invalid']);
  await fs.writeFile(path.join(repo, 'app.txt'), 'v1\n');
  await git(repo, ['add', 'app.txt']);
  await git(repo, ['commit', '-m', 'initial']);
  const commit = await git(repo, ['rev-parse', 'HEAD']);
  return { parent, repo, stateDir, worktreeRoot, commit };
}

function permissions(repo: string): PermissionProfile {
  return {
    allowedCapabilities: [
      'developer.worktree.create',
      'developer.worktree.inspect',
      'developer.worktree.release'
    ],
    allowedRoots: [repo],
    allowExternalWrites: false,
    allowSystemChanges: false,
    allowDestructive: false
  };
}

function action(input: {
  id: string;
  capability: 'developer.worktree.create' | 'developer.worktree.inspect' | 'developer.worktree.release';
  risk: 'write' | 'read' | 'destructive';
  sessionId: string;
  repositoryRoot: string;
  baseCommit?: string;
  expectedFingerprint?: string;
}): ActionRequest {
  return {
    id: input.id,
    capability: input.capability,
    risk: input.risk,
    input: {
      sessionId: input.sessionId,
      repositoryRoot: input.repositoryRoot,
      ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
      ...(input.expectedFingerprint ? { expectedFingerprint: input.expectedFingerprint } : {})
    },
    provenance: { kind: 'chatgpt' }
  };
}

test('Developer Worktree provider is session-bound and destructive release requires approval', async (t) => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const fx = await fixture(t);
  const sessions = new DeveloperSessionStore(fx.stateDir);
  const session = createDeveloperSession({
    objective: 'Edit the isolated project.',
    acceptanceCriteria: ['The exact base commit is isolated.'],
    workspaceRootNodeId: 'workspace:root',
    now: '2026-10-06T00:00:00.000Z'
  });
  await sessions.put(session);

  const provider = new DeveloperWorktreeProvider({
    allowedRoots: [fx.repo],
    worktreeRoot: fx.worktreeRoot,
    stateDir: fx.stateDir,
    clock: () => new Date('2026-10-06T00:00:00.000Z')
  });
  const runtime = new OperatorRuntime().register(provider);
  const basePermissions = permissions(fx.repo);

  const createAction = action({
    id: 'create-worktree',
    capability: 'developer.worktree.create',
    risk: 'write',
    sessionId: session.id,
    repositoryRoot: fx.repo,
    baseCommit: fx.commit
  });
  const created = await runtime.execute(createAction, basePermissions);
  assert.equal(created.ok, true);
  const createdOutput = created.output as {
    phase: string;
    worktreePath: string;
    fingerprint: string;
    sessionStatus: string;
  };
  assert.equal(createdOutput.phase, 'ACTIVE');
  assert.equal(createdOutput.sessionStatus, 'PLANNING');
  assert.equal(await git(createdOutput.worktreePath, ['rev-parse', 'HEAD']), fx.commit);

  const inspectAction = action({
    id: 'inspect-worktree',
    capability: 'developer.worktree.inspect',
    risk: 'read',
    sessionId: session.id,
    repositoryRoot: fx.repo
  });
  const inspected = await runtime.execute(inspectAction, basePermissions);
  assert.equal(inspected.ok, true);
  const inspectedOutput = inspected.output as {
    fingerprint: string;
    clean: boolean;
    worktreePath: string;
  };
  assert.equal(inspectedOutput.clean, true);
  assert.match(inspectedOutput.fingerprint, /^[0-9a-f]{64}$/);

  const releaseAction = action({
    id: 'release-worktree',
    capability: 'developer.worktree.release',
    risk: 'destructive',
    sessionId: session.id,
    repositoryRoot: fx.repo,
    expectedFingerprint: inspectedOutput.fingerprint
  });
  const denied = await runtime.execute(releaseAction, basePermissions);
  assert.equal(denied.ok, false);
  assert.equal(denied.error?.code, 'APPROVAL_REQUIRED');
  assert.equal(await fs.stat(inspectedOutput.worktreePath).then((stat) => stat.isDirectory()), true);

  const approved = await runtime.execute(releaseAction, {
    ...basePermissions,
    approvedActionIds: [releaseAction.id]
  });
  assert.equal(approved.ok, true);
  assert.equal((approved.output as { phase: string }).phase, 'RELEASED');
  await assert.rejects(
    fs.stat(inspectedOutput.worktreePath),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
});

test('Developer Worktree create refuses missing or terminal Developer Sessions before worktree mutation', async (t) => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const fx = await fixture(t);
  const provider = new DeveloperWorktreeProvider({
    allowedRoots: [fx.repo],
    worktreeRoot: fx.worktreeRoot,
    stateDir: fx.stateDir
  });
  const runtime = new OperatorRuntime().register(provider);
  const perms = permissions(fx.repo);

  const missing = await runtime.execute(action({
    id: 'missing-session',
    capability: 'developer.worktree.create',
    risk: 'write',
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    repositoryRoot: fx.repo,
    baseCommit: fx.commit
  }), perms);
  assert.equal(missing.ok, false);
  assert.equal(missing.error?.code, 'DEVELOPER_SESSION_NOT_FOUND');

  const store = new DeveloperSessionStore(fx.stateDir);
  const active = createDeveloperSession({
    objective: 'Already finished.',
    acceptanceCriteria: ['No new workspace may be created.'],
    workspaceRootNodeId: 'workspace:root',
    now: '2026-10-06T00:00:00.000Z'
  });
  const terminal = updateDeveloperSession(active, {
    status: 'COMPLETED'
  }, '2026-10-06T00:01:00.000Z');
  await store.put(terminal);

  const refused = await runtime.execute(action({
    id: 'terminal-session',
    capability: 'developer.worktree.create',
    risk: 'write',
    sessionId: terminal.id,
    repositoryRoot: fx.repo,
    baseCommit: fx.commit
  }), perms);
  assert.equal(refused.ok, false);
  assert.equal(refused.error?.code, 'DEVELOPER_WORKTREE_SESSION_TERMINAL');

  await assert.rejects(
    fs.stat(fx.worktreeRoot),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
});

test('Developer Worktree provider reconciliation proves completed create and release states', async (t) => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const fx = await fixture(t);
  const sessions = new DeveloperSessionStore(fx.stateDir);
  const session = createDeveloperSession({
    objective: 'Exercise reconciliation.',
    acceptanceCriteria: ['Lifecycle truth can be re-established.'],
    workspaceRootNodeId: 'workspace:root',
    now: '2026-10-06T00:00:00.000Z'
  });
  await sessions.put(session);

  const provider = new DeveloperWorktreeProvider({
    allowedRoots: [fx.repo],
    worktreeRoot: fx.worktreeRoot,
    stateDir: fx.stateDir
  });
  const runtime = new OperatorRuntime().register(provider);
  const perms = permissions(fx.repo);

  const createAction = action({
    id: 'reconcile-create',
    capability: 'developer.worktree.create',
    risk: 'write',
    sessionId: session.id,
    repositoryRoot: fx.repo,
    baseCommit: fx.commit
  });
  const created = await runtime.execute(createAction, perms);
  assert.equal(created.ok, true);

  const createReconciled = await runtime.reconcile(
    createAction,
    provider.name,
    created
  );
  assert.equal(createReconciled.status, 'completed');
  assert.equal(createReconciled.result?.ok, true);

  const inspectAction = action({
    id: 'reconcile-inspect',
    capability: 'developer.worktree.inspect',
    risk: 'read',
    sessionId: session.id,
    repositoryRoot: fx.repo
  });
  const inspected = await runtime.execute(inspectAction, perms);
  const fingerprint = (inspected.output as { fingerprint: string }).fingerprint;

  const releaseAction = action({
    id: 'reconcile-release',
    capability: 'developer.worktree.release',
    risk: 'destructive',
    sessionId: session.id,
    repositoryRoot: fx.repo,
    expectedFingerprint: fingerprint
  });
  const released = await runtime.execute(releaseAction, {
    ...perms,
    approvedActionIds: [releaseAction.id]
  });
  assert.equal(released.ok, true);

  const releaseReconciled = await runtime.reconcile(
    releaseAction,
    provider.name,
    released
  );
  assert.equal(releaseReconciled.status, 'completed');
  assert.equal(releaseReconciled.result?.ok, true);
  assert.equal((releaseReconciled.result?.output as { phase: string }).phase, 'RELEASED');
});
