import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { DeveloperWorktreeProvider } from '../src/capabilities/developer-worktree.ts';
import type { ActionRequest } from '../src/core/types.ts';
import { supportedGitAvailable } from './git-test-support.ts';

const execAsync = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const r = await execAsync('git', args, {
    cwd, encoding: 'utf8',
    env: {
      ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: nullConfig,
      GIT_CONFIG_SYSTEM: nullConfig, GIT_CONFIG_NOSYSTEM: '1',
      GIT_NO_LAZY_FETCH: '1'
    }
  });
  return String(r.stdout ?? '').trim();
}
async function fixture(t: test.TestContext) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-private-worktree-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const repositoryRoot = path.join(parent, 'repository');
  const stateDir = path.join(parent, 'state');
  const worktreeRoot = path.join(parent, 'owned-worktrees');
  await fs.mkdir(repositoryRoot);
  await git(repositoryRoot, ['init']);
  await git(repositoryRoot, ['config', 'user.name', 'Source CI']);
  await git(repositoryRoot, ['config', 'user.email', 'source-ci@local.invalid']);
  await fs.writeFile(path.join(repositoryRoot, 'README.txt'), 'original\n');
  await git(repositoryRoot, ['add', 'README.txt']);
  await git(repositoryRoot, ['commit', '-m', 'initial']);
  return {
    repositoryRoot, stateDir, worktreeRoot,
    baseCommit: await git(repositoryRoot, ['rev-parse', 'HEAD'])
  };
}
function action(capability: string, risk: ActionRequest['risk'],
  input: Record<string, unknown>, id = capability): ActionRequest {
  return { id, capability, risk, input, provenance: { kind: 'runtime' } };
}

test('C06 private worktree provider is source-only and not registered through the default runtime', async t => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const fx = await fixture(t);
  const { createRuntime } = await import('../apps/local-agent/src/runtime-factory.ts');
  const runtime = createRuntime({
    stateDir: fx.stateDir, allowedRoots: [fx.repositoryRoot],
    allowedExecutables: []
  });
  const result = await runtime.execute(action('workspace.worktree.create', 'write', {
    sessionId: 'source-only', repositoryRoot: fx.repositoryRoot, baseCommit: fx.baseCommit
  }), { allowedCapabilities: ['workspace.worktree.create'], allowedRoots: [fx.repositoryRoot] });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code === 'CAPABILITY_RISK_UNREGISTERED' ||
    result.error?.code === 'NO_PROVIDER', true,
    'private provider must not silently widen production runtime surface');
});

test('C06 isolated provider validates exact create, inspect, clean release and durable reconciliation', async t => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const fx = await fixture(t);
  const provider = new DeveloperWorktreeProvider({
    allowedRepositoryRoots: [fx.repositoryRoot], stateDir: fx.stateDir,
    worktreeRoot: fx.worktreeRoot
  });
  const input = {
    sessionId: 'owned-test', repositoryRoot: fx.repositoryRoot, baseCommit: fx.baseCommit
  };
  const create = action('workspace.worktree.create', 'write', input);
  const created = await provider.execute(create);
  assert.equal(created.ok, true, created.error?.message);
  const result = created.output as Record<string, unknown>;
  assert.equal(result.phase, 'ACTIVE');
  assert.equal(result.head, fx.baseCommit);
  assert.equal(result.clean, true);
  assert.equal((await provider.reconcile({ action: create })).status, 'completed');
  const inspect = await provider.execute(action('workspace.worktree.inspect', 'read', input));
  assert.equal(inspect.ok, true, inspect.error?.message);
  assert.equal((inspect.output as Record<string, unknown>).fingerprint, result.fingerprint);

  const release = action('workspace.worktree.release', 'destructive', {
    ...input, expectedFingerprint: result.fingerprint
  });
  const resultRelease = await provider.execute(release);
  assert.equal(resultRelease.ok, true, resultRelease.error?.message);
  assert.equal((resultRelease.output as Record<string, unknown>).phase, 'RELEASED');
  assert.equal((await provider.reconcile({ action: release })).status, 'completed');
  assert.equal((await fs.readFile(path.join(fx.repositoryRoot, 'README.txt'), 'utf8')),
    'original\n', 'source repository must not be modified or removed');
});

test('C06 private worktree provider denies coerced identities, invalid risk and pre-aborted actions', async t => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const fx = await fixture(t);
  const provider = new DeveloperWorktreeProvider({
    allowedRepositoryRoots: [fx.repositoryRoot], stateDir: fx.stateDir,
    worktreeRoot: fx.worktreeRoot
  });
  let methodsInvoked = 0;
  const spoof = { toString() { methodsInvoked++; return 'owned-test'; } };
  const target = {
    sessionId: 'owned-test', repositoryRoot: fx.repositoryRoot, baseCommit: fx.baseCommit
  };
  for (const input of [
    { ...target, sessionId: spoof },
    { ...target, baseCommit: spoof },
    { ...target, repositoryRoot: spoof },
    Object.defineProperty({ ...target }, 'sessionId', {
      enumerable: true, get() { methodsInvoked++; return 'owned-test'; }
    })
  ]) {
    const result = await provider.execute(action('workspace.worktree.create', 'write', input));
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'DEVELOPER_WORKTREE_INPUT_INVALID');
    assert.equal(result.error?.sideEffectState, 'none');
  }
  assert.equal(methodsInvoked, 0, 'untrusted input hooks must never execute');
  const riskMismatch = await provider.execute(action('workspace.worktree.release', 'read', target));
  assert.equal(riskMismatch.ok, false);
  assert.equal(riskMismatch.error?.code, 'DEVELOPER_WORKTREE_RISK_MISMATCH');

  const abort = new AbortController();
  abort.abort();
  const cancelled = await provider.execute(
    action('workspace.worktree.create', 'write', target), { signal: abort.signal });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error?.sideEffectState, 'none');
  assert.equal((await provider.reconcile({ action: action(
    'workspace.worktree.create', 'write', target
  ) })).status, 'uncertain', 'missing journal is never evidence of no side effect');
});
