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

test('Developer Worktree lifecycle conflicts with Git mutations of its source repository', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-worktree-resource-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git'));

  const worktree: ActionRequest = {
    id: 'worktree',
    capability: 'developer.worktree.create',
    risk: 'write',
    input: {
      sessionId: 'session-1',
      repositoryRoot: root,
      baseCommit: 'a'.repeat(40)
    },
    provenance: { kind: 'runtime' }
  };
  const gitWrite: ActionRequest = {
    id: 'git',
    capability: 'git.write',
    risk: 'write',
    input: { cwd: root, operation: 'stage', paths: ['a.txt'] },
    provenance: { kind: 'runtime' }
  };

  const left = await resolvePhysicalResourceKeysForAction(worktree);
  const right = await resolvePhysicalResourceKeysForAction(gitWrite);

  assert.equal(left.some((key) => key === 'developer-worktree:session-1'), true);
  assert.equal(
    left.some((a) => right.some((b) => resourceKeysConflict(a, b))),
    true
  );
  assert.equal(left.some((key) => key.startsWith('fs-path:')), true);
});

test('Developer Worktree actions for one session conflict even if repository input differs', async () => {
  const create: ActionRequest = {
    id: 'create',
    capability: 'developer.worktree.create',
    risk: 'write',
    input: {
      sessionId: 'session-same',
      repositoryRoot: path.resolve('repo-a'),
      baseCommit: 'a'.repeat(40)
    },
    provenance: { kind: 'runtime' }
  };
  const release: ActionRequest = {
    id: 'release',
    capability: 'developer.worktree.release',
    risk: 'destructive',
    input: {
      sessionId: 'session-same',
      repositoryRoot: path.resolve('repo-b'),
      expectedFingerprint: 'b'.repeat(64)
    },
    provenance: { kind: 'runtime' }
  };

  const left = await resolvePhysicalResourceKeysForAction(create);
  const right = await resolvePhysicalResourceKeysForAction(release);
  assert.equal(
    left.some((a) => right.some((b) => resourceKeysConflict(a, b))),
    true
  );
});
