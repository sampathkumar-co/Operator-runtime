import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { FilesystemProvider } from '../src/capabilities/filesystem.ts';
import { GitProvider } from '../src/capabilities/git.ts';
import { supportedGitAvailable } from './git-test-support.ts';
import type { ActionRequest, ActionRisk, PermissionProfile } from '../src/core/types.ts';

const scopedTest = supportedGitAvailable() && (process.platform !== 'win32' ||
  Boolean(process.env.OPERATOR_WINDOWS_PATH_LEASE_PATH)) ? test : test.skip;
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}
async function setup(t: test.TestContext) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'c06-dev-workflow-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'project');
  const outside = path.join(temp, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'C06 Disposable Fixture');
  git(root, 'config', 'user.email', 'c06@example.invalid');
  const filepath = path.join(root, 'README.md');
  await fs.writeFile(filepath, 'build=old\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'fixture baseline');
  const initialSha = git(root, 'rev-parse', 'HEAD').trim();
  const runtime = new OperatorRuntime()
    .register(new FilesystemProvider({ allowedRoots: [root],
      windowsPathLeaseExecutable: process.env.OPERATOR_WINDOWS_PATH_LEASE_PATH }))
    .register(new GitProvider({ allowedRoots: [root] }));
  t.after(() => runtime.close());
  const perms: PermissionProfile = {
    allowedRoots: [root],
    allowedCapabilities: ['file.read', 'file.replace', 'git.status', 'git.diff'],
    maxRisk: 'destructive', approvedActionIds: ['c06-approved-replace', 'c06-approved-stale']
  };
  const action = (id: string, capability: string, risk: ActionRisk,
    input: Record<string, unknown>): ActionRequest => ({
      id, capability, risk, input, provenance: { kind: 'user' }
    });
  return { root, outside, filepath, initialSha, runtime, perms, action };
}

scopedTest('C06 model-neutral file and Git pipeline proves bytes, diff and preserved HEAD', async t => {
  const x = await setup(t);
  const first = await x.runtime.execute(x.action('c06-initial-read', 'file.read', 'read',
    { path: x.filepath }), x.perms);
  assert.equal(first.ok, true, first.error?.message);
  assert.equal((first.output as any).sha256, hash('build=old\n'));
  const unapproved = await x.runtime.execute(x.action('c06-unapproved-replace', 'file.replace', 'destructive',
    { path: x.filepath, content: 'build=changed\n', expectedSha256: hash('build=old\n') }), x.perms);
  assert.equal(unapproved.ok, false);
  assert.equal(unapproved.error?.code, 'APPROVAL_REQUIRED');
  assert.equal(await fs.readFile(x.filepath, 'utf8'), 'build=old\n');

  const approved = await x.runtime.execute(x.action('c06-approved-replace', 'file.replace', 'destructive',
    { path: x.filepath, content: 'build=new\n',
      expectedSha256: (first.output as any).sha256 }), x.perms);
  assert.equal(approved.ok, true, approved.error?.message);
  assert.equal(hash(await fs.readFile(x.filepath, 'utf8')), hash('build=new\n'));
  const diff = await x.runtime.execute(x.action('c06-diff', 'git.diff', 'read',
    { cwd: x.root, paths: ['README.md'], publicLiteralFiles: true }), x.perms);
  assert.equal(diff.ok, true, diff.error?.message);
  assert.match(String((diff.output as any).stdout), /-build=old/);
  assert.match(String((diff.output as any).stdout), /\+build=new/);
  assert.equal(git(x.root, 'rev-parse', 'HEAD').trim(), x.initialSha);
});
scopedTest('C06 stale approval and out-of-root read cannot mutate the approved project', async t => {
  const x = await setup(t);
  const stale = await x.runtime.execute(x.action('c06-approved-stale', 'file.replace', 'destructive',
    { path: x.filepath, content: 'tamper', expectedSha256: hash('obsolete') }), x.perms);
  assert.equal(stale.ok, false);
  assert.equal(stale.error?.code, 'PRECONDITION_FAILED');
  const denied = await x.runtime.execute(x.action('c06-outside', 'file.read', 'read',
    { path: path.join(x.outside, 'secrets.txt') }), x.perms);
  assert.equal(denied.ok, false);
  assert.equal(denied.error?.code, 'PATH_OUTSIDE_SCOPE');
  assert.equal(await fs.readFile(x.filepath, 'utf8'), 'build=old\n');
  assert.equal(git(x.root, 'status', '--porcelain'), '');
});
