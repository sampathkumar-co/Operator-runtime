import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { DeveloperWorktreeProvider } from '../src/capabilities/developer-worktree.ts';
import { developerWorktreeRecordPath } from '../src/core/developer-worktree.ts';
import { writeDurableStateText } from '../src/core/durable-state.ts';
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
  assert.equal((await provider.reconcile({ action: release })).status, 'uncertain',
    'terminal absence alone cannot prove which release fingerprint authorized it');
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


test('C06 private reconcile rejects wrongly risked release as unproven', async t => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const fx = await fixture(t);
  const provider = new DeveloperWorktreeProvider({
    allowedRepositoryRoots: [fx.repositoryRoot],
    worktreeRoot: fx.worktreeRoot, stateDir: fx.stateDir
  });
  const forged = action('workspace.worktree.release', 'read', {
    repositoryRoot: fx.repositoryRoot, sessionId: 'owned-test',
    expectedFingerprint: 'a'.repeat(64)
  });
  const outcome = await provider.reconcile({ action: forged });
  assert.equal(outcome.status, 'uncertain',
    'mislabeled destructive action cannot certify read-only recovery');
});


test('C06 worktree creation and subsequent inspection accept symlinked ancestor paths', async t => {
  if (process.platform === 'win32' || !supportedGitAvailable()) {
    t.skip('directory aliases require a POSIX disposable Git fixture'); return;
  }
  const fx = await fixture(t);
  const parent = path.dirname(fx.repositoryRoot);
  const alias = path.join(parent, 'parent-alias');
  await fs.symlink(parent, alias, 'dir');
  const viaAncestorAlias = path.join(alias, path.basename(fx.repositoryRoot));
  const provider = new DeveloperWorktreeProvider({
    allowedRepositoryRoots: [fx.repositoryRoot],
    worktreeRoot: fx.worktreeRoot, stateDir: fx.stateDir
  });
  const input = {
    sessionId: 'alias-session', repositoryRoot: viaAncestorAlias,
    baseCommit: fx.baseCommit
  };
  const result = await provider.execute(action('workspace.worktree.create', 'write', input));
  assert.equal(result.ok, true, result.error?.message);
  const inspected = await provider.execute(action('workspace.worktree.inspect', 'read', input));
  assert.equal(inspected.ok, true, inspected.error?.message);
  const state = result.output as Record<string, unknown>;
  const release = await provider.execute(action('workspace.worktree.release', 'destructive', {
    ...input, expectedFingerprint: state.fingerprint
  }));
  assert.equal(release.ok, true, release.error?.message);
});

test('C06 create recovery never certifies a moved HEAD as the original session commit', async t => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const fx = await fixture(t);
  const provider = new DeveloperWorktreeProvider({
    allowedRepositoryRoots: [fx.repositoryRoot],
    worktreeRoot: fx.worktreeRoot, stateDir: fx.stateDir
  });
  const original = action('workspace.worktree.create', 'write', {
    sessionId: 'head-moved', repositoryRoot: fx.repositoryRoot,
    baseCommit: fx.baseCommit
  });
  const result = await provider.execute(original);
  assert.equal(result.ok, true, result.error?.message);
  const worktree = (result.output as Record<string, unknown>).worktreePath as string;
  await fs.writeFile(path.join(fx.repositoryRoot, 'README.txt'), 'new commit\n');
  await git(fx.repositoryRoot, ['add', 'README.txt']);
  await git(fx.repositoryRoot, ['commit', '-m', 'second']);
  const newCommit = await git(fx.repositoryRoot, ['rev-parse', 'HEAD']);
  await git(worktree, ['checkout', '--detach', newCommit]);
  const spoof = action('workspace.worktree.create', 'write', {
    sessionId: 'head-moved', repositoryRoot: fx.repositoryRoot,
    baseCommit: newCommit
  });
  const proof = await provider.reconcile({ action: spoof });
  assert.equal(proof.status, 'uncertain',
    'moved HEAD may not certify a new create intent bound to another original commit');
});


test('C06 release preflight and reconciliation never finalize an unfinished create journal', async t => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const fx = await fixture(t);
  const provider = new DeveloperWorktreeProvider({
    allowedRepositoryRoots: [fx.repositoryRoot], worktreeRoot: fx.worktreeRoot,
    stateDir: fx.stateDir
  });
  const input = { sessionId: 'interrupted-create', repositoryRoot: fx.repositoryRoot,
    baseCommit: fx.baseCommit };
  const created = await provider.execute(action('workspace.worktree.create', 'write', input));
  assert.equal(created.ok, true, created.error?.message);
  const fingerprint = (created.output as Record<string, unknown>).fingerprint as string;
  const file = developerWorktreeRecordPath(fx.stateDir, input.sessionId);
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  await writeDurableStateText(file, JSON.stringify({ ...record, phase: 'CREATING' }), {
    maxBytes: 256 * 1024, errorCode: 'DEVELOPER_WORKTREE_STATE_CORRUPT',
    invalidMessage: 'Developer worktree state is invalid.'
  });
  const before = await fs.readFile(file, 'utf8');
  const release = action('workspace.worktree.release', 'destructive', {
    ...input, expectedFingerprint: fingerprint
  });
  const denied = await provider.execute(release);
  assert.equal(denied.ok, false);
  assert.equal(denied.error?.code, 'DEVELOPER_WORKTREE_READ_UNCERTAIN');
  assert.equal(denied.error?.sideEffectState, 'none');
  assert.equal(denied.error?.executionPhase, 'pre_dispatch');
  assert.equal(await fs.readFile(file, 'utf8'), before,
    'release preflight cannot rewrite unfinished durable creation evidence');
  const recon = await provider.reconcile({ action: release });
  assert.equal(recon.status, 'uncertain');
  assert.equal(await fs.readFile(file, 'utf8'), before,
    'reconciliation cannot perform state changes while claiming independent proof');
  assert.equal((await fs.readFile(path.join(fx.repositoryRoot, 'README.txt'), 'utf8')),
    'original\n', 'original repository remains unmodified');
});


test('C06 opt-in runtime binds worktree risk, repository authority and exact resource identity', async t => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const fx = await fixture(t);
  const { createRuntime } = await import('../apps/local-agent/src/runtime-factory.ts');
  const { capabilityRiskRule } = await import('../src/core/capability-policy.ts');
  const { resourceKeysForAction, resolvePhysicalResourceKeysForAction, resourceKeysConflict } =
    await import('../src/core/resource-identity.ts');

  assert.equal(capabilityRiskRule('workspace.worktree.create'), 'write');
  assert.equal(capabilityRiskRule('workspace.worktree.inspect'), 'read');
  assert.equal(capabilityRiskRule('workspace.worktree.release'), 'destructive');

  const options = {
    stateDir: fx.stateDir, allowedRoots: [fx.repositoryRoot], allowedExecutables: [],
    developerWorktree: { enabled: true as const, worktreeRoot: fx.worktreeRoot }
  };
  const runtime = createRuntime(options);
  await runtime.assertMutationReconciliationCoverage();
  assert.ok(await runtime.router.provider('workspace.worktree.git'));
  const input = {
    sessionId: 'scoped-session', repositoryRoot: fx.repositoryRoot,
    baseCommit: fx.baseCommit
  };
  const create = action('workspace.worktree.create', 'write', input);
  const scope = {
    allowedCapabilities: ['workspace.worktree.create', 'workspace.worktree.inspect',
      'workspace.worktree.release'],
    allowedRoots: [fx.repositoryRoot],
    maxRisk: 'destructive' as const
  };
  const denied = await runtime.execute(create, {
    ...scope, allowedCapabilities: ['git.status']
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error?.code, 'CAPABILITY_DENIED');

  const badScope = await runtime.execute(action('workspace.worktree.create', 'write', {
    ...input, repositoryRoot: path.join(path.dirname(fx.repositoryRoot), 'out-of-scope')
  }, 'outside-root'), scope);
  assert.equal(badScope.ok, false);
  assert.equal(badScope.error?.code, 'PATH_OUTSIDE_SCOPE');

  const badRisk = await runtime.execute(action('workspace.worktree.create', 'read',
    input, 'risk-underclaim'), scope);
  assert.equal(badRisk.ok, false);
  assert.equal(badRisk.error?.code, 'ACTION_RISK_MISMATCH');

  const keys = await resolvePhysicalResourceKeysForAction(create);
  const gitKeys = await resolvePhysicalResourceKeysForAction(action(
    'git.status', 'read', { cwd: fx.repositoryRoot }));
  assert.ok(keys.includes('developer-worktree:session:scoped-session'));
  assert.ok(resourceKeysForAction(create).some(key => key.startsWith('repo:')));
  assert.ok(keys.some(a => gitKeys.some(b => resourceKeysConflict(a,b))),
    'Git and worktree operations on same root must conflict');

  const created = await runtime.execute(create, scope);
  assert.equal(created.ok, true, created.error?.message);
  const state = created.output as Record<string, unknown>;
  assert.equal(state.phase, 'ACTIVE');
  assert.equal(state.head, fx.baseCommit);
  const inspected = await runtime.execute(action('workspace.worktree.inspect', 'read', input),scope);
  assert.equal(inspected.ok, true, inspected.error?.message);
  assert.equal((inspected.output as Record<string, unknown>).fingerprint,state.fingerprint);

  const release = action('workspace.worktree.release', 'destructive', {
    ...input, expectedFingerprint: state.fingerprint
  });
  const noApproval = await runtime.execute(release, scope);
  assert.equal(noApproval.ok,false);
  assert.equal(noApproval.error?.code,'APPROVAL_REQUIRED');
  const released = await runtime.execute(release, {
    ...scope, approvedActionIds: [release.id]
  });
  assert.equal(released.ok,true,released.error?.message);
  assert.equal((released.output as Record<string, unknown>).phase,'RELEASED');
  assert.equal(await fs.readFile(path.join(fx.repositoryRoot,'README.txt'),'utf8'),
    'original\n','original repo cannot be changed by owned worktree release');
});

test('C06 private worktree is disabled unless owner supplies complete explicit local opt-in', async t => {
  if (!supportedGitAvailable()) { t.skip('supported Git unavailable'); return; }
  const fx = await fixture(t);
  const { createRuntime } = await import('../apps/local-agent/src/runtime-factory.ts');
  const options = { allowedRoots:[fx.repositoryRoot],allowedExecutables:[] };
  assert.throws(() => createRuntime({
    ...options, developerWorktree: {
      enabled: true as const, worktreeRoot: fx.worktreeRoot
    }
  }), (e:any) => e?.code === 'DEVELOPER_WORKTREE_OPT_IN_INVALID');
  const defaultRuntime = createRuntime({ ...options,stateDir:fx.stateDir });
  assert.equal(await defaultRuntime.router.provider('workspace.worktree.git'),undefined);
  assert.throws(() => createRuntime({
    ...options, stateDir:fx.stateDir,
    developerWorktree: { enabled:true as const,worktreeRoot:'relative/worktree' }
  }), (e:any) => e?.code === 'DEVELOPER_WORKTREE_OPT_IN_INVALID');
});
