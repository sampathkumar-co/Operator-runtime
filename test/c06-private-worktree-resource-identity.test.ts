import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  privateDeveloperWorktreeResourceKeysForAction,
  resolvePhysicalResourceKeysForAction, resourceKeysConflict
} from '../src/core/resource-identity.ts';
import type { ActionRequest } from '../src/core/types.ts';

function req(capability: string, risk: ActionRequest['risk'],
  input: Record<string, unknown>): ActionRequest {
  return {
    id: 'c06-identity', capability, risk, input,
    provenance: { kind: 'runtime' }
  };
}
function overlap(left: string[], right: string[]): boolean {
  return left.some(a => right.some(b => resourceKeysConflict(a, b)));
}
test('C06 private worktree resource keys overlap Git on the same physical repository', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-c06-worktree-keys-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const different = path.join(base, 'other');
  await fs.mkdir(root);
  await fs.mkdir(different);
  const action = req('workspace.worktree.create', 'write', {
    sessionId: 'one', repositoryRoot: root, baseCommit: 'a'.repeat(40)
  });
  const keys = await privateDeveloperWorktreeResourceKeysForAction(action);
  assert.equal(keys.includes('developer-worktree:session:one'), true);
  const punctuated = await privateDeveloperWorktreeResourceKeysForAction(req(
    'workspace.worktree.inspect', 'read',
    { sessionId: 'owner:device@one', repositoryRoot: root }
  ));
  assert.ok(punctuated.includes('developer-worktree:session:owner:device@one'),
    'private scheduler key must exactly match the durable manager lease namespace');
  assert.ok(keys.some(key => key.startsWith('fs-path:')));
  const git = await resolvePhysicalResourceKeysForAction(req('git.status', 'read', { cwd: root }));
  assert.equal(overlap(keys, git), true,
    'worktree create and Git must serialize when they touch the same physical root');
  const another = await privateDeveloperWorktreeResourceKeysForAction(req(
    'workspace.worktree.release', 'destructive', {
      sessionId: 'one', repositoryRoot: different, expectedFingerprint: 'b'.repeat(64)
    }
  ));
  assert.equal(overlap(keys, another), true,
    'same session must conflict before identity can be reconciled');
  const separate = await privateDeveloperWorktreeResourceKeysForAction(req(
    'workspace.worktree.inspect', 'read', { sessionId: 'two', repositoryRoot: different }
  ));
  assert.equal(overlap(keys, separate), false,
    'unrelated sessions and repositories retain independent scheduling');
});

test('C06 worktree path aliases resolve to the same underlying resource keys', async t => {
  if (process.platform === 'win32') { t.skip('POSIX symlink fixture'); return; }
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-c06-alias-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const actual = path.join(base, 'repository');
  const alias = path.join(base, 'alias');
  await fs.mkdir(actual);
  await fs.symlink(actual, alias, 'dir');
  const viaAlias = await privateDeveloperWorktreeResourceKeysForAction(req(
    'workspace.worktree.inspect', 'read', {
      sessionId: 'read-one', repositoryRoot: alias
    }
  ));
  const git = await resolvePhysicalResourceKeysForAction(req('git.status', 'read', { cwd: actual }));
  assert.equal(overlap(viaAlias, git), true,
    'physical path identity must prevent an alias from bypassing Git resource locking');
});

test('C06 private mapper fails closed for getter-backed, coerced or misrisked worktree identity', async () => {
  let invoked = 0;
  const forged = { toString() { invoked++; return '/tmp/root'; },
    valueOf() { invoked++; return '/tmp/root'; } };
  const base = { sessionId: 'safe', repositoryRoot: '/tmp/root' };
  const attacks: ActionRequest[] = [
    req('workspace.worktree.create', 'read', base),
    req('workspace.worktree.create', 'write', { ...base, repositoryRoot: forged }),
    req('workspace.worktree.inspect', 'read', { ...base, sessionId: forged }),
    req('workspace.worktree.inspect', 'read', { ...base, repositoryRoot: 'relative/path' }),
    req('workspace.worktree.release', 'write', base),
    req('workspace.worktree.unknown', 'write', base),
    req('workspace.worktree.inspect', 'read', Object.defineProperty({ ...base },
      'repositoryRoot', { enumerable: true, get() { invoked++; return '/tmp/root'; } }))
  ];
  for (const action of attacks) {
    await assert.rejects(
      privateDeveloperWorktreeResourceKeysForAction(action),
      (error: any) => error?.code === 'RESOURCE_TARGET_INVALID'
    );
  }
  assert.equal(invoked, 0, 'no forged object hooks or accessors execute');
});
