import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { HermeticWorkspaceProvider } from '../src/capabilities/hermetic-workspace.ts';
import { resolveSupportedGitExecutable } from '../src/core/trusted-executable.ts';
import type { ActionRequest } from '../src/core/types.ts';

const execFileAsync = promisify(execFile);

function gitAvailable(): boolean {
  try {
    resolveSupportedGitExecutable(process.env);
    return true;
  } catch {
    return false;
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const executable = resolveSupportedGitExecutable(process.env);
  const { stdout } = await execFileAsync(executable, args, {
    cwd,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    encoding: 'utf8',
    env: process.env
  });
  return stdout.trim();
}

async function createRepository(t: { after: (fn: () => Promise<void>) => void }) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-hermetic-'));
  t.after(async () => fs.rm(parent, { recursive: true, force: true }));
  const sourceRoot = path.join(parent, 'source');
  const stateDir = path.join(parent, 'state');
  await fs.mkdir(sourceRoot);
  await fs.mkdir(stateDir);
  await runGit(sourceRoot, ['init']);
  await runGit(sourceRoot, ['config', 'user.name', 'Mecord Test']);
  await runGit(sourceRoot, ['config', 'user.email', 'mecord-test@local.invalid']);
  await fs.mkdir(path.join(sourceRoot, 'src'));
  await fs.writeFile(path.join(sourceRoot, 'src', 'index.ts'), 'export const value = 1;\n');
  await fs.writeFile(path.join(sourceRoot, 'package-lock.json'), '{"name":"fixture","lockfileVersion":3}\n');
  await runGit(sourceRoot, ['add', '-A']);
  await runGit(sourceRoot, ['commit', '-m', 'initial']);
  const head = (await runGit(sourceRoot, ['rev-parse', 'HEAD'])).toLowerCase();
  return { parent, sourceRoot, stateDir, head };
}

function provisionAction(sourceRoot: string, sessionId: string, expectedHead: string): ActionRequest {
  return {
    id: 'provision:' + sessionId,
    capability: 'workspace.hermetic.provision',
    risk: 'write',
    input: { sourceRoot, sessionId, expectedHead },
    provenance: { kind: 'runtime' }
  };
}

test('hermetic workspace provisions exact detached commit, fingerprints locks, and releases explicitly', {
  skip: !gitAvailable()
}, async (t) => {
  const { sourceRoot, stateDir, head } = await createRepository(t);
  const provider = new HermeticWorkspaceProvider({
    allowedRoots: [sourceRoot],
    stateDir,
    clock: () => new Date('2026-10-06T00:00:00.000Z')
  });

  const provision = await provider.execute(provisionAction(sourceRoot, 'session-one', head));
  assert.equal(provision.ok, true, provision.error?.message);
  const manifest = (provision.output as any).manifest;
  assert.equal(manifest.sourceHead, head);
  assert.match(manifest.id, /^[0-9a-f]{64}$/);
  assert.equal(manifest.dependencyLocks.length, 1);
  assert.equal(manifest.dependencyLocks[0].path, 'package-lock.json');
  assert.equal(manifest.dependencyLocks[0].sha256, crypto.createHash('sha256')
    .update(await fs.readFile(path.join(sourceRoot, 'package-lock.json')))
    .digest('hex'));

  assert.equal((await runGit(manifest.worktreeRoot, ['rev-parse', 'HEAD'])).toLowerCase(), head);
  assert.equal(await runGit(manifest.worktreeRoot, ['status', '--porcelain']), '');

  const inspect = await provider.execute({
    id: 'inspect:session-one',
    capability: 'workspace.hermetic.inspect',
    risk: 'read',
    input: { sessionId: 'session-one' },
    provenance: { kind: 'runtime' }
  });
  assert.equal(inspect.ok, true);
  assert.equal((inspect.output as any).healthy, true);

  const releaseAction: ActionRequest = {
    id: 'release:session-one',
    capability: 'workspace.hermetic.release',
    risk: 'destructive',
    input: {
      sourceRoot,
      sessionId: 'session-one',
      expectedManifestId: manifest.id
    },
    provenance: { kind: 'runtime' }
  };
  const released = await provider.execute(releaseAction);
  assert.equal(released.ok, true, released.error?.message);
  await assert.rejects(
    fs.stat(manifest.worktreeRoot),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  );

  const reconciled = await provider.reconcile({ action: releaseAction });
  assert.equal(reconciled.status, 'completed');
});

test('stale expectedHead fails before owned worktree creation', {
  skip: !gitAvailable()
}, async (t) => {
  const { sourceRoot, stateDir, head } = await createRepository(t);
  await fs.writeFile(path.join(sourceRoot, 'src', 'index.ts'), 'export const value = 2;\n');
  await runGit(sourceRoot, ['add', '-A']);
  await runGit(sourceRoot, ['commit', '-m', 'second']);

  const provider = new HermeticWorkspaceProvider({ allowedRoots: [sourceRoot], stateDir });
  const result = await provider.execute(provisionAction(sourceRoot, 'stale-session', head));

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'HERMETIC_WORKSPACE_HEAD_CHANGED');
  assert.equal(result.error?.sideEffectState, 'none');
  await assert.rejects(
    fs.stat(path.join(stateDir, 'hermetic-workspaces')),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
});

test('repo-local content filters are rejected before worktree checkout', {
  skip: !gitAvailable()
}, async (t) => {
  const { sourceRoot, stateDir, head } = await createRepository(t);
  await runGit(sourceRoot, ['config', 'filter.bad.smudge', 'cat']);
  const provider = new HermeticWorkspaceProvider({ allowedRoots: [sourceRoot], stateDir });

  const result = await provider.execute(provisionAction(sourceRoot, 'filter-session', head));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'HERMETIC_WORKSPACE_CONTENT_FILTER_DENIED');
  assert.equal(result.error?.sideEffectState, 'none');
  await assert.rejects(
    fs.stat(path.join(stateDir, 'hermetic-workspaces')),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
});

test('dependency-lock drift is surfaced as unhealthy without mutating the worktree', {
  skip: !gitAvailable()
}, async (t) => {
  const { sourceRoot, stateDir, head } = await createRepository(t);
  const provider = new HermeticWorkspaceProvider({ allowedRoots: [sourceRoot], stateDir });
  const provision = await provider.execute(provisionAction(sourceRoot, 'drift-session', head));
  assert.equal(provision.ok, true, provision.error?.message);
  const manifest = (provision.output as any).manifest;

  await fs.writeFile(path.join(manifest.worktreeRoot, 'package-lock.json'), '{"name":"changed"}\n');
  const inspect = await provider.execute({
    id: 'inspect:drift-session',
    capability: 'workspace.hermetic.inspect',
    risk: 'read',
    input: { sessionId: 'drift-session' },
    provenance: { kind: 'runtime' }
  });

  assert.equal(inspect.ok, true);
  assert.equal((inspect.output as any).healthy, false);
  assert.equal((inspect.output as any).healthCode, 'HERMETIC_WORKSPACE_LOCK_DRIFT');
  assert.equal(await fs.readFile(path.join(manifest.worktreeRoot, 'package-lock.json'), 'utf8'), '{"name":"changed"}\n');

  const release = await provider.execute({
    id: 'release:drift-session',
    capability: 'workspace.hermetic.release',
    risk: 'destructive',
    input: { sourceRoot, sessionId: 'drift-session', expectedManifestId: manifest.id },
    provenance: { kind: 'runtime' }
  });
  assert.equal(release.ok, true, release.error?.message);
});

test('release requires exact manifest identity and source repository', {
  skip: !gitAvailable()
}, async (t) => {
  const { parent, sourceRoot, stateDir, head } = await createRepository(t);
  const provider = new HermeticWorkspaceProvider({ allowedRoots: [sourceRoot], stateDir });
  const provision = await provider.execute(provisionAction(sourceRoot, 'release-guard', head));
  assert.equal(provision.ok, true, provision.error?.message);
  const manifest = (provision.output as any).manifest;

  const wrongManifest = await provider.execute({
    id: 'release:wrong-manifest',
    capability: 'workspace.hermetic.release',
    risk: 'destructive',
    input: { sourceRoot, sessionId: 'release-guard', expectedManifestId: 'f'.repeat(64) },
    provenance: { kind: 'runtime' }
  });
  assert.equal(wrongManifest.ok, false);
  assert.equal(wrongManifest.error?.code, 'HERMETIC_WORKSPACE_MANIFEST_CHANGED');
  assert.equal(wrongManifest.error?.sideEffectState, 'none');
  assert.equal((await fs.stat(manifest.worktreeRoot)).isDirectory(), true);

  const otherRepo = path.join(parent, 'other');
  await fs.mkdir(otherRepo);
  await runGit(otherRepo, ['init']);
  const wrongSourceProvider = new HermeticWorkspaceProvider({
    allowedRoots: [sourceRoot, otherRepo],
    stateDir
  });
  const wrongSource = await wrongSourceProvider.execute({
    id: 'release:wrong-source',
    capability: 'workspace.hermetic.release',
    risk: 'destructive',
    input: { sourceRoot: otherRepo, sessionId: 'release-guard', expectedManifestId: manifest.id },
    provenance: { kind: 'runtime' }
  });
  assert.equal(wrongSource.ok, false);
  assert.equal(wrongSource.error?.code, 'HERMETIC_WORKSPACE_SOURCE_CHANGED');
  assert.equal(wrongSource.error?.sideEffectState, 'none');
  assert.equal((await fs.stat(manifest.worktreeRoot)).isDirectory(), true);
});
