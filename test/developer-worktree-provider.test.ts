import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { DeveloperWorktreeProvider } from '../src/capabilities/developer-worktree.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import type { ActionRequest } from '../src/core/types.ts';
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
  await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
  await git(repo, ['add', 'a.txt']);
  await git(repo, ['commit', '-m', 'initial']);
  const commit = await git(repo, ['rev-parse', 'HEAD']);
  return { parent, repo, stateDir, worktreeRoot, commit };
}

function action(
  id: string,
  capability: ActionRequest['capability'],
  risk: ActionRequest['risk'],
  input: Record<string, unknown>
): ActionRequest {
  return {
    id,
    capability,
    risk,
    input,
    provenance: { kind: 'runtime' }
  };
}

test('Developer Worktree provider exposes separately risked create, inspect and release operations', async (t) => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const fx = await fixture(t);
  const provider = new DeveloperWorktreeProvider({
    allowedRepositoryRoots: [fx.repo],
    worktreeRoot: fx.worktreeRoot,
    stateDir: fx.stateDir
  });

  const create = action('wt-create', 'workspace.worktree.create', 'write', {
    sessionId: 'session-provider',
    repositoryRoot: fx.repo,
    baseCommit: fx.commit
  });
  const created = await provider.execute(create);
  assert.equal(created.ok, true);
  const createdOutput = created.output as { fingerprint?: string; phase?: string; worktreePath?: string };
  assert.equal(createdOutput.phase, 'ACTIVE');
  assert.match(createdOutput.fingerprint ?? '', /^[0-9a-f]{64}$/);

  const inspected = await provider.execute(action(
    'wt-inspect',
    'workspace.worktree.inspect',
    'read',
    { sessionId: 'session-provider', repositoryRoot: fx.repo }
  ));
  assert.equal(inspected.ok, true);
  assert.equal((inspected.output as { clean?: boolean }).clean, true);

  const wrongRisk = await provider.execute(action(
    'wt-release-wrong-risk',
    'workspace.worktree.release',
    'write',
    {
      sessionId: 'session-provider',
      repositoryRoot: fx.repo,
      expectedFingerprint: createdOutput.fingerprint
    }
  ));
  assert.equal(wrongRisk.ok, false);
  assert.equal(wrongRisk.error?.code, 'DEVELOPER_WORKTREE_RISK_MISMATCH');
  assert.equal(await fs.stat(createdOutput.worktreePath ?? '').then(() => true), true);

  const released = await provider.execute(action(
    'wt-release',
    'workspace.worktree.release',
    'destructive',
    {
      sessionId: 'session-provider',
      repositoryRoot: fx.repo,
      expectedFingerprint: createdOutput.fingerprint
    }
  ));
  assert.equal(released.ok, true);
  assert.equal((released.output as { phase?: string }).phase, 'RELEASED');
});

test('Developer Worktree provider reconciliation proves create and release post-state', async (t) => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const fx = await fixture(t);
  const provider = new DeveloperWorktreeProvider({
    allowedRepositoryRoots: [fx.repo],
    worktreeRoot: fx.worktreeRoot,
    stateDir: fx.stateDir
  });
  const create = action('wt-create-reconcile', 'workspace.worktree.create', 'write', {
    sessionId: 'session-reconcile',
    repositoryRoot: fx.repo,
    baseCommit: fx.commit
  });
  const before = await provider.reconcile({ action: create });
  assert.equal(before.status, 'not_applied');

  const created = await provider.execute(create);
  assert.equal(created.ok, true);
  const after = await provider.reconcile({ action: create, priorResult: created });
  assert.equal(after.status, 'completed');

  const fingerprint = (created.output as { fingerprint?: string }).fingerprint!;
  const release = action('wt-release-reconcile', 'workspace.worktree.release', 'destructive', {
    sessionId: 'session-reconcile',
    repositoryRoot: fx.repo,
    expectedFingerprint: fingerprint
  });
  const releaseBefore = await provider.reconcile({ action: release });
  assert.equal(releaseBefore.status, 'not_applied');
  const released = await provider.execute(release);
  assert.equal(released.ok, true);
  const releaseAfter = await provider.reconcile({ action: release, priorResult: released });
  assert.equal(releaseAfter.status, 'completed');
});

test('local runtime registers Developer Worktree mutations only when explicit isolation root is configured', async (t) => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const fx = await fixture(t);
  const create = action('runtime-wt-create', 'workspace.worktree.create', 'write', {
    sessionId: 'runtime-session',
    repositoryRoot: fx.repo,
    baseCommit: fx.commit
  });
  const permissions = {
    allowedCapabilities: ['workspace.worktree.create'],
    allowedRoots: [fx.repo],
    maxRisk: 'write' as const
  };

  const withoutIsolation = createRuntime({
    stateDir: fx.stateDir,
    allowedRoots: [fx.repo],
    allowedExecutables: []
  });
  const denied = await withoutIsolation.execute(create, permissions);
  assert.equal(denied.ok, false);
  assert.equal(denied.error?.code, 'NO_PROVIDER');

  const withIsolation = createRuntime({
    stateDir: fx.stateDir,
    developerWorktreeRoot: fx.worktreeRoot,
    allowedRoots: [fx.repo],
    allowedExecutables: []
  });
  const allowed = await withIsolation.execute(
    { ...create, id: 'runtime-wt-create-enabled' },
    permissions
  );
  assert.equal(allowed.ok, true);
});
