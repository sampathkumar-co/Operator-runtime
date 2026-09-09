import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GitCheckpointProvider } from '../src/capabilities/git-checkpoint.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function createRepo(t: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-checkpoint-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Operator CI');
  git(root, 'config', 'user.email', 'operator-ci@example.invalid');
  await fs.writeFile(path.join(root, 'base.txt'), 'base\n');
  await fs.writeFile(path.join(root, 'staged.txt'), 'original staged\n');
  git(root, 'add', 'base.txt', 'staged.txt');
  git(root, 'commit', '-m', 'base');
  return root;
}

test('Git checkpoint creation is non-mutating and restore reproduces staged, unstaged, and untracked state', async (t) => {
  const root = await createRepo(t);
  const provider = new GitCheckpointProvider({ allowedRoots: [root] });

  await fs.writeFile(path.join(root, 'base.txt'), 'checkpoint unstaged\n');
  await fs.writeFile(path.join(root, 'staged.txt'), 'checkpoint staged\n');
  git(root, 'add', 'staged.txt');
  await fs.writeFile(path.join(root, 'untracked.txt'), 'checkpoint untracked\n');

  const headBefore = git(root, 'rev-parse', 'HEAD').trim();
  const statusBefore = git(root, 'status', '--porcelain=v1', '--untracked-files=all');

  const created = await provider.execute({
    id: 'checkpoint-create',
    capability: 'git.checkpoint.create',
    risk: 'write',
    input: { cwd: root, label: 'integration checkpoint' },
    provenance: { kind: 'chatgpt' }
  });
  assert.equal(created.ok, true, created.error?.message);
  const checkpoint = created.output as any;
  assert.match(checkpoint.id, /^[0-9a-f-]{36}$/i);
  assert.match(checkpoint.fingerprint, /^[0-9a-f]{64}$/i);
  assert.equal(git(root, 'rev-parse', 'HEAD').trim(), headBefore);
  assert.equal(git(root, 'status', '--porcelain=v1', '--untracked-files=all'), statusBefore);

  await fs.writeFile(path.join(root, 'base.txt'), 'later unstaged\n');
  await fs.writeFile(path.join(root, 'staged.txt'), 'later staged\n');
  git(root, 'add', 'staged.txt');
  await fs.rm(path.join(root, 'untracked.txt'));
  await fs.writeFile(path.join(root, 'later-only.txt'), 'remove me on restore\n');

  const inspected = await provider.execute({
    id: 'checkpoint-inspect',
    capability: 'git.checkpoint.inspect',
    risk: 'read',
    input: { cwd: root },
    provenance: { kind: 'chatgpt' }
  });
  assert.equal(inspected.ok, true, inspected.error?.message);
  const current = (inspected.output as any).current;
  assert.notEqual(current.fingerprint, checkpoint.fingerprint);
  assert.equal((inspected.output as any).checkpoints.some((item: any) => item.id === checkpoint.id), true);

  const restored = await provider.execute({
    id: 'checkpoint-restore',
    capability: 'git.checkpoint.restore',
    risk: 'destructive',
    input: {
      cwd: root,
      checkpointId: checkpoint.id,
      expectedCurrentFingerprint: current.fingerprint
    },
    provenance: { kind: 'chatgpt' }
  });
  assert.equal(restored.ok, true, restored.error?.message);
  assert.match(String((restored.output as any).recoveryCheckpointId), /^[0-9a-f-]{36}$/i);

  assert.equal(git(root, 'rev-parse', 'HEAD').trim(), headBefore);
  assert.equal(git(root, 'status', '--porcelain=v1', '--untracked-files=all'), statusBefore);
  assert.equal(await fs.readFile(path.join(root, 'base.txt'), 'utf8'), 'checkpoint unstaged\n');
  assert.equal(await fs.readFile(path.join(root, 'staged.txt'), 'utf8'), 'checkpoint staged\n');
  assert.equal(await fs.readFile(path.join(root, 'untracked.txt'), 'utf8'), 'checkpoint untracked\n');
  await assert.rejects(fs.access(path.join(root, 'later-only.txt')));

  const after = await provider.execute({
    id: 'checkpoint-after',
    capability: 'git.checkpoint.inspect',
    risk: 'read',
    input: { cwd: root },
    provenance: { kind: 'runtime' }
  });
  assert.equal(after.ok, true);
  assert.equal((after.output as any).current.fingerprint, checkpoint.fingerprint);
});

test('Git checkpoint restore rejects a stale repository-state fingerprint before mutation', async (t) => {
  const root = await createRepo(t);
  const provider = new GitCheckpointProvider({ allowedRoots: [root] });
  await fs.writeFile(path.join(root, 'base.txt'), 'checkpoint state\n');

  const created = await provider.execute({
    id: 'create-stale-test', capability: 'git.checkpoint.create', risk: 'write',
    input: { cwd: root }, provenance: { kind: 'chatgpt' }
  });
  assert.equal(created.ok, true);

  const inspected = await provider.execute({
    id: 'inspect-stale-test', capability: 'git.checkpoint.inspect', risk: 'read',
    input: { cwd: root }, provenance: { kind: 'chatgpt' }
  });
  const staleFingerprint = (inspected.output as any).current.fingerprint;

  await fs.writeFile(path.join(root, 'base.txt'), 'newer work that must survive\n');
  const rejected = await provider.execute({
    id: 'restore-stale-test', capability: 'git.checkpoint.restore', risk: 'destructive',
    input: {
      cwd: root,
      checkpointId: (created.output as any).id,
      expectedCurrentFingerprint: staleFingerprint
    },
    provenance: { kind: 'chatgpt' }
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error?.code, 'CHECKPOINT_STATE_CHANGED');
  assert.equal(await fs.readFile(path.join(root, 'base.txt'), 'utf8'), 'newer work that must survive\n');
});
