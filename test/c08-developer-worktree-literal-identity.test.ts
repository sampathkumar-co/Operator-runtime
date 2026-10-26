import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeveloperWorktreeManager, developerWorktreeRecordPath } from '../src/core/developer-worktree.ts';
import { writeDurableStateText } from '../src/core/durable-state.ts';

const STATE_OPTIONS = {
  maxBytes: 256 * 1024, errorCode: 'DEVELOPER_WORKTREE_STATE_CORRUPT',
  invalidMessage: 'Developer worktree state is invalid.'
} as const;

async function fixture(t: test.TestContext) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-worktree-identity-'));
  t.after(() => fs.rm(parent, { force: true, recursive: true }));
  const repo = path.join(parent, 'repo');
  const stateDir = path.join(parent, 'state');
  const worktreeRoot = path.join(parent, 'worktrees');
  await Promise.all([fs.mkdir(repo), fs.mkdir(stateDir), fs.mkdir(worktreeRoot)]);
  const mgr = new DeveloperWorktreeManager({
    allowedRepositoryRoots: [repo], worktreeRoot, stateDir
  });
  return { mgr, parent, repo, stateDir, worktreeRoot };
}

test('C08 worktree session and Git id boundaries refuse caller conversion hooks', async (t) => {
  const fx = await fixture(t);
  let conversions = 0;
  const spoof = { toString() { conversions++; return 'valid-session'; },
    valueOf() { conversions++; return 1; } };
  assert.throws(() => developerWorktreeRecordPath(fx.stateDir, spoof as any),
    (e: any) => e?.code === 'DEVELOPER_WORKTREE_SESSION_ID_INVALID');
  await assert.rejects(fx.mgr.inspect(spoof as any),
    (e: any) => e?.code === 'DEVELOPER_WORKTREE_SESSION_ID_INVALID');
  await assert.rejects(fx.mgr.create({
    sessionId: spoof as any, repositoryRoot: fx.repo, baseCommit: 'a'.repeat(40)
  }), (e: any) => e?.code === 'DEVELOPER_WORKTREE_SESSION_ID_INVALID');
  await assert.rejects(fx.mgr.create({
    sessionId: 'test', repositoryRoot: fx.repo, baseCommit: ['a'.repeat(40)] as any
  }), (e: any) => e?.code === 'DEVELOPER_WORKTREE_COMMIT_INVALID');
  await assert.rejects(fx.mgr.release({
    sessionId: 'test', expectedFingerprint: ['b'.repeat(64)] as any
  }), (e: any) => e?.code === 'DEVELOPER_WORKTREE_PRECONDITION_INVALID');
  assert.equal(conversions, 0, 'No authority identifier calls toString/valueOf');
});

test('C08 worktree request getters cannot switch authorizing scope before dispatch', async (t) => {
  const fx = await fixture(t);
  let calls = 0;
  const payload = Object.defineProperty({
    sessionId: 'no-execution', baseCommit: 'a'.repeat(40), repositoryRoot: fx.repo
  }, 'repositoryRoot', {
    enumerable: true, get() { calls++; return fx.repo; }
  });
  await assert.rejects(fx.mgr.create(payload),
    (e: any) => e?.code === 'DEVELOPER_WORKTREE_IDENTITY_INVALID');
  assert.equal(calls, 0);
  await assert.rejects(fx.mgr.release(Object.defineProperty({
    sessionId: 'no-execution', expectedFingerprint: 'b'.repeat(64)
  }, 'expectedFingerprint', {
    enumerable: true, get() { calls++; return 'b'.repeat(64); }
  })), (e: any) => e?.code === 'DEVELOPER_WORKTREE_IDENTITY_INVALID');
  assert.equal(calls, 0);
});

test('C08 forged persisted worktree status, timestamp and paths must not be coerced', async (t) => {
  const fx = await fixture(t);
  const sessionId = 'typed-record';
  const ownedPath = path.join(fx.worktreeRoot,
    crypto.createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 32));
  const normal = {
    schemaVersion: 1, sessionId, repositoryRoot: fx.repo,
    worktreePath: ownedPath, baseCommit: 'a'.repeat(40),
    phase: 'CREATING', createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z'
  };
  const destination = developerWorktreeRecordPath(fx.stateDir, sessionId);
  for (const changed of [
    { phase: ['CREATING'] },
    { baseCommit: ['a'.repeat(40)] },
    { createdAt: ['2026-10-26T00:00:00.000Z'] },
    { updatedAt: ['2026-10-26T00:00:00.000Z'] },
    { worktreePath: [ownedPath] },
    { repositoryRoot: [fx.repo] }
  ]) {
    await writeDurableStateText(destination, JSON.stringify({ ...normal, ...changed }), STATE_OPTIONS);
    await assert.rejects(fx.mgr.inspect(sessionId),
      (e: any) => e?.code === 'DEVELOPER_WORKTREE_STATE_CORRUPT');
  }
});
