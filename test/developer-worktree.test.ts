import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  DeveloperWorktreeManager,
  developerWorktreeRecordPath,
  type DeveloperWorktreeRecord
} from '../src/core/developer-worktree.ts';
import {
  readDurableStateText,
  writeDurableStateText
} from '../src/core/durable-state.ts';
import { supportedGitAvailable } from './git-test-support.ts';

const execFileAsync = promisify(execFile);
const RECORD_OPTIONS = {
  maxBytes: 256 * 1024,
  errorCode: 'DEVELOPER_WORKTREE_STATE_CORRUPT',
  invalidMessage: 'Developer worktree state is invalid.'
} as const;

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
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-worktree-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const repo = path.join(parent, 'repo');
  const worktreeRoot = path.join(parent, 'isolated-worktrees');
  const stateDir = path.join(parent, 'control-state');
  await fs.mkdir(repo);
  await git(repo, ['init']);
  await git(repo, ['config', 'user.name', 'Mecord Test']);
  await git(repo, ['config', 'user.email', 'mecord-test@local.invalid']);
  await fs.writeFile(path.join(repo, 'app.txt'), 'v1\n');
  await git(repo, ['add', 'app.txt']);
  await git(repo, ['commit', '-m', 'initial']);
  const commit = await git(repo, ['rev-parse', 'HEAD']);
  return { parent, repo, worktreeRoot, stateDir, commit };
}

function manager(input: {
  repo: string;
  worktreeRoot: string;
  stateDir: string;
}): DeveloperWorktreeManager {
  return new DeveloperWorktreeManager({
    allowedRepositoryRoots: [input.repo],
    worktreeRoot: input.worktreeRoot,
    stateDir: input.stateDir,
    clock: () => new Date('2026-10-06T00:00:00.000Z')
  });
}

function worktreePath(root: string, sessionId: string): string {
  const key = crypto.createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 32);
  return path.join(root, key);
}

test('Developer Worktree creates an exact detached clean worktree and releases only with a fresh fingerprint', async (t) => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const fx = await fixture(t);
  const mgr = manager(fx);

  const created = await mgr.create({
    sessionId: 'session-create-release',
    repositoryRoot: fx.repo,
    baseCommit: fx.commit
  });

  assert.equal(created.record.phase, 'ACTIVE');
  assert.equal(created.exists, true);
  assert.equal(created.head, fx.commit);
  assert.equal(created.clean, true);
  assert.match(created.fingerprint ?? '', /^[0-9a-f]{64}$/);
  assert.equal(await git(created.record.worktreePath, ['rev-parse', 'HEAD']), fx.commit);
  assert.equal((await git(created.record.worktreePath, ['symbolic-ref', '-q', 'HEAD']).catch(() => '')), '');

  const released = await mgr.release({
    sessionId: 'session-create-release',
    expectedFingerprint: created.fingerprint!
  });
  assert.equal(released.record.phase, 'RELEASED');
  assert.equal(released.exists, false);
  await assert.rejects(
    fs.stat(created.record.worktreePath),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
});

test('Developer Worktree refuses release when workspace bytes are dirty', async (t) => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const fx = await fixture(t);
  const mgr = manager(fx);
  const created = await mgr.create({
    sessionId: 'session-dirty',
    repositoryRoot: fx.repo,
    baseCommit: fx.commit
  });

  await fs.writeFile(path.join(created.record.worktreePath, 'app.txt'), 'changed\n');
  const dirty = await mgr.inspect('session-dirty');
  assert.equal(dirty.clean, false);

  await assert.rejects(
    () => mgr.release({
      sessionId: 'session-dirty',
      expectedFingerprint: dirty.fingerprint!
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_WORKTREE_DIRTY');
      return true;
    }
  );
  assert.equal(await fs.readFile(path.join(created.record.worktreePath, 'app.txt'), 'utf8'), 'changed\n');
});

test('Developer Worktree creation recovery promotes an exact Git-created worktree after a crash before ACTIVE journal commit', async (t) => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const fx = await fixture(t);
  const sessionId = 'session-create-recovery';
  await fs.mkdir(fx.worktreeRoot, { recursive: true });
  await fs.mkdir(fx.stateDir, { recursive: true });
  const canonicalWorktreeRoot = await fs.realpath(fx.worktreeRoot);
  const ownedPath = worktreePath(canonicalWorktreeRoot, sessionId);

  const now = '2026-10-06T00:00:00.000Z';
  const record: DeveloperWorktreeRecord = {
    schemaVersion: 1,
    sessionId,
    repositoryRoot: fx.repo,
    worktreePath: ownedPath,
    baseCommit: fx.commit,
    phase: 'CREATING',
    createdAt: now,
    updatedAt: now
  };
  await writeDurableStateText(
    developerWorktreeRecordPath(fx.stateDir, sessionId),
    JSON.stringify(record),
    RECORD_OPTIONS
  );

  await git(fx.repo, ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), 'worktree', 'add', '--detach', ownedPath, fx.commit]);

  const recovered = await manager(fx).inspect(sessionId);
  assert.equal(recovered.record.phase, 'ACTIVE');
  assert.equal(recovered.head, fx.commit);
  assert.equal(recovered.clean, true);
  assert.ok(recovered.record.gitDir);
  assert.ok(recovered.record.commonDir);
});

test('Developer Worktree release recovery marks RELEASED after Git removed the worktree before journal commit', async (t) => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const fx = await fixture(t);
  const sessionId = 'session-release-recovery';
  const mgr = manager(fx);
  const created = await mgr.create({
    sessionId,
    repositoryRoot: fx.repo,
    baseCommit: fx.commit
  });

  const recordPath = developerWorktreeRecordPath(fx.stateDir, sessionId);
  const active = JSON.parse(await readDurableStateText(recordPath, RECORD_OPTIONS)) as DeveloperWorktreeRecord;
  const releasing: DeveloperWorktreeRecord = {
    ...active,
    phase: 'RELEASING',
    updatedAt: '2026-10-06T00:00:01.000Z'
  };
  await writeDurableStateText(recordPath, JSON.stringify(releasing), RECORD_OPTIONS);
  await git(fx.repo, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'remove', created.record.worktreePath]);

  const recovered = await manager(fx).inspect(sessionId);
  assert.equal(recovered.record.phase, 'RELEASED');
  assert.equal(recovered.exists, false);
});

test('Developer Worktree refuses repository-local content filters before checkout can execute them', async (t) => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const fx = await fixture(t);
  await git(fx.repo, ['config', 'filter.operator-test.smudge', 'definitely-not-a-command']);

  await assert.rejects(
    () => manager(fx).create({
      sessionId: 'session-filter-denied',
      repositoryRoot: fx.repo,
      baseCommit: fx.commit
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_WORKTREE_CONTENT_FILTER_DENIED');
      return true;
    }
  );
  await assert.rejects(
    fs.stat(worktreePath(fx.worktreeRoot, 'session-filter-denied')),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
});

test('Developer Worktree control state cannot live inside an authorized source repository', async (t) => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const fx = await fixture(t);
  const bad = new DeveloperWorktreeManager({
    allowedRepositoryRoots: [fx.repo],
    worktreeRoot: fx.worktreeRoot,
    stateDir: path.join(fx.repo, '.mecord-control')
  });

  await assert.rejects(
    () => bad.create({
      sessionId: 'session-bad-control-state',
      repositoryRoot: fx.repo,
      baseCommit: fx.commit
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_WORKTREE_STATE_PROJECT_OVERLAP');
      return true;
    }
  );
});

test('released Developer Worktree session IDs cannot be rebound or reused', async (t) => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const fx = await fixture(t);
  const mgr = manager(fx);
  const created = await mgr.create({
    sessionId: 'session-no-reuse',
    repositoryRoot: fx.repo,
    baseCommit: fx.commit
  });
  await mgr.release({
    sessionId: 'session-no-reuse',
    expectedFingerprint: created.fingerprint!
  });

  await assert.rejects(
    () => mgr.create({
      sessionId: 'session-no-reuse',
      repositoryRoot: fx.repo,
      baseCommit: fx.commit
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_WORKTREE_SESSION_REUSED');
      return true;
    }
  );
});

test('Developer Worktree isolation root cannot contain an authorized source repository', async (t) => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-worktree-overlap-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const isolationRoot = path.join(parent, 'isolation');
  const repo = path.join(isolationRoot, 'source-repo');
  const stateDir = path.join(parent, 'control');
  await fs.mkdir(repo, { recursive: true });
  await git(repo, ['init']);
  await git(repo, ['config', 'user.name', 'Mecord Test']);
  await git(repo, ['config', 'user.email', 'mecord-test@local.invalid']);
  await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
  await git(repo, ['add', 'a.txt']);
  await git(repo, ['commit', '-m', 'initial']);
  const commit = await git(repo, ['rev-parse', 'HEAD']);

  const mgr = new DeveloperWorktreeManager({
    allowedRepositoryRoots: [repo],
    worktreeRoot: isolationRoot,
    stateDir
  });
  await assert.rejects(
    () => mgr.create({ sessionId: 'overlap', repositoryRoot: repo, baseCommit: commit }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_WORKTREE_ROOT_PROJECT_OVERLAP');
      return true;
    }
  );
});

test('Developer Worktree control root cannot contain an authorized source repository', async (t) => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-worktree-overlap-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const stateDir = path.join(parent, 'control');
  const repo = path.join(stateDir, 'source-repo');
  const worktreeRoot = path.join(parent, 'worktrees');
  await fs.mkdir(repo, { recursive: true });
  await git(repo, ['init']);
  await git(repo, ['config', 'user.name', 'Mecord Test']);
  await git(repo, ['config', 'user.email', 'mecord-test@local.invalid']);
  await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
  await git(repo, ['add', 'a.txt']);
  await git(repo, ['commit', '-m', 'initial']);
  const commit = await git(repo, ['rev-parse', 'HEAD']);

  const mgr = new DeveloperWorktreeManager({
    allowedRepositoryRoots: [repo],
    worktreeRoot,
    stateDir
  });
  await assert.rejects(
    () => mgr.create({ sessionId: 'overlap-state', repositoryRoot: repo, baseCommit: commit }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_WORKTREE_STATE_PROJECT_OVERLAP');
      return true;
    }
  );
});
