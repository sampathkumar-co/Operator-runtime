import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GitCheckpointProvider } from '../src/capabilities/git-checkpoint.ts';
import { GitWriteProvider } from '../src/capabilities/git-write.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function createRepo(t: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-git-write-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Operator CI');
  git(root, 'config', 'user.email', 'operator-ci@example.invalid');
  await fs.writeFile(path.join(root, 'a.txt'), 'base a\n');
  await fs.writeFile(path.join(root, 'keep.txt'), 'keep\n');
  git(root, 'add', 'a.txt', 'keep.txt');
  git(root, 'commit', '-m', 'base');
  return root;
}

async function fingerprint(checkpoint: GitCheckpointProvider, root: string): Promise<string> {
  const inspected = await checkpoint.execute({
    id: 'state', capability: 'git.checkpoint.inspect', risk: 'read',
    input: { cwd: root }, provenance: { kind: 'runtime' }
  });
  assert.equal(inspected.ok, true, inspected.error?.message);
  return String((inspected.output as any).current.fingerprint);
}

test('structured Git write stages, unstages, and commits with checkpoints while repository hooks stay disabled', async (t) => {
  const root = await createRepo(t);
  const checkpoint = new GitCheckpointProvider({ allowedRoots: [root] });
  const writer = new GitWriteProvider({ allowedRoots: [root] });

  await fs.writeFile(path.join(root, 'a.txt'), 'changed a\n');
  await fs.writeFile(path.join(root, 'b.txt'), 'new b\n');

  const stageFingerprint = await fingerprint(checkpoint, root);
  const staged = await writer.execute({
    id: 'stage', capability: 'git.write', risk: 'write', provenance: { kind: 'chatgpt' },
    input: {
      operation: 'stage', cwd: root, paths: ['a.txt', 'b.txt'],
      expectedCurrentFingerprint: stageFingerprint
    }
  });
  assert.equal(staged.ok, true, staged.error?.message);
  assert.match(String((staged.output as any).checkpointId), /^[0-9a-f-]{36}$/i);
  const stagedNames = git(root, 'diff', '--cached', '--name-only').trim().split(/\r?\n/).sort();
  assert.deepEqual(stagedNames, ['a.txt', 'b.txt']);

  const unstageFingerprint = await fingerprint(checkpoint, root);
  const unstaged = await writer.execute({
    id: 'unstage', capability: 'git.write', risk: 'write', provenance: { kind: 'chatgpt' },
    input: {
      operation: 'unstage', cwd: root, paths: ['b.txt'],
      expectedCurrentFingerprint: unstageFingerprint
    }
  });
  assert.equal(unstaged.ok, true, unstaged.error?.message);
  assert.equal(git(root, 'diff', '--cached', '--name-only').trim(), 'a.txt');
  assert.match(git(root, 'status', '--porcelain=v1'), /\?\? b\.txt/);

  const marker = path.join(root, 'hook-ran.marker');
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  await fs.writeFile(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 1\n`);
  await fs.chmod(hook, 0o755);

  const headBefore = git(root, 'rev-parse', 'HEAD').trim();
  const commitFingerprint = await fingerprint(checkpoint, root);
  const committed = await writer.execute({
    id: 'commit', capability: 'git.write', risk: 'write', provenance: { kind: 'chatgpt' },
    input: {
      operation: 'commit', cwd: root, message: 'test: structured commit',
      expectedCurrentFingerprint: commitFingerprint
    }
  });
  assert.equal(committed.ok, true, committed.error?.message);
  const output = committed.output as any;
  assert.notEqual(output.newHead, headBefore);
  assert.equal(output.previousHead, headBefore);
  assert.equal(git(root, 'rev-parse', 'HEAD^').trim(), headBefore);
  assert.equal(git(root, 'log', '-1', '--pretty=%s').trim(), 'test: structured commit');
  assert.equal(git(root, 'show', '--pretty=', '--name-only', 'HEAD').trim(), 'a.txt');
  await assert.rejects(fs.access(marker));
  assert.match(git(root, 'status', '--porcelain=v1'), /\?\? b\.txt/);
});

test('structured Git write rejects stale fingerprints and pathspec magic before mutation', async (t) => {
  const root = await createRepo(t);
  const checkpoint = new GitCheckpointProvider({ allowedRoots: [root] });
  const writer = new GitWriteProvider({ allowedRoots: [root] });
  await fs.writeFile(path.join(root, 'a.txt'), 'first change\n');
  const stale = await fingerprint(checkpoint, root);
  await fs.writeFile(path.join(root, 'a.txt'), 'newer change\n');

  const staleResult = await writer.execute({
    id: 'stale-stage', capability: 'git.write', risk: 'write', provenance: { kind: 'chatgpt' },
    input: { operation: 'stage', cwd: root, paths: ['a.txt'], expectedCurrentFingerprint: stale }
  });
  assert.equal(staleResult.ok, false);
  assert.equal(staleResult.error?.code, 'GIT_WRITE_STATE_CHANGED');
  assert.equal(git(root, 'diff', '--cached', '--name-only').trim(), '');

  const fresh = await fingerprint(checkpoint, root);
  const magic = await writer.execute({
    id: 'magic-stage', capability: 'git.write', risk: 'write', provenance: { kind: 'chatgpt' },
    input: { operation: 'stage', cwd: root, paths: [':(glob)**'], expectedCurrentFingerprint: fresh }
  });
  assert.equal(magic.ok, false);
  assert.equal(magic.error?.code, 'INVALID_GIT_PATH');
  assert.equal(git(root, 'diff', '--cached', '--name-only').trim(), '');
});
