import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  resolvePhysicalResourceKeysForAction,
  resourceKeysConflict
} from '../src/core/resource-identity.ts';
import type { ActionRequest } from '../src/core/types.ts';

function action(
  id: string,
  capability: string,
  risk: ActionRequest['risk'],
  input: Record<string, unknown>
): ActionRequest {
  return { id, capability, risk, input, provenance: { kind: 'runtime' } };
}

test('Developer Worktree mutations conflict with Git operations on the same physical repository', async (t) => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-worktree-resource-'));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await fs.mkdir(path.join(repo, '.git'));

  const worktree = action('worktree', 'workspace.worktree.create', 'write', {
    sessionId: 'session-a',
    repositoryRoot: repo,
    baseCommit: 'a'.repeat(40)
  });
  const git = action('git', 'git.status', 'read', { cwd: repo });

  const left = await resolvePhysicalResourceKeysForAction(worktree);
  const right = await resolvePhysicalResourceKeysForAction(git);
  assert.equal(
    left.some((a) => right.some((b) => resourceKeysConflict(a, b))),
    true
  );
  assert.equal(left.includes('developer-worktree:session-a'), true);
});

test('same Developer Worktree session identity conflicts even before filesystem resolution', async () => {
  const left = await resolvePhysicalResourceKeysForAction(action(
    'a',
    'workspace.worktree.inspect',
    'read',
    { sessionId: 'shared-session', repositoryRoot: '/repo-a' }
  ));
  const right = await resolvePhysicalResourceKeysForAction(action(
    'b',
    'workspace.worktree.release',
    'destructive',
    { sessionId: 'shared-session', repositoryRoot: '/repo-b', expectedFingerprint: 'a'.repeat(64) }
  ));
  assert.equal(
    left.some((a) => right.some((b) => resourceKeysConflict(a, b))),
    true
  );
});
