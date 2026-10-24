import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { GitProvider } from '../src/capabilities/git.ts';
import { supportedGitAvailable } from './git-test-support.ts';
import type { ActionRequest, PermissionProfile } from '../src/core/types.ts';

const gitTest = supportedGitAvailable() ? test : test.skip;
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
async function fixture(t: test.TestContext) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'wave0-lane-b-git-'));
  const root = path.join(base, 'authorized');
  const outside = path.join(base, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Wave0 CI');
  git(root, 'config', 'user.email', 'wave0@example.invalid');
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'customer.txt'), 'customer=v1\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'frozen baseline');
  const baselineSha = git(root, 'rev-parse', 'HEAD').trim();
  const runtime = new OperatorRuntime().register(new GitProvider({ allowedRoots: [root] }));
  const permission: PermissionProfile = {
    allowedRoots: [root], allowedCapabilities: ['git.status', 'git.diff'],
    maxRisk: 'read'
  };
  const action = (id: string, capability: string, input: Record<string, unknown>): ActionRequest => ({
    id, capability, risk: 'read', input, provenance: { kind: 'user' }
  });
  return { root, outside, baselineSha, runtime, permission, action };
}

gitTest('C01 Lane B scripted Git status and literal diff agree with independent repository bytes', async t => {
  const { root, baselineSha, runtime, permission, action } = await fixture(t);
  await fs.writeFile(path.join(root, 'src', 'customer.txt'), 'customer=v2\n');
  const target = 'src/customer.txt';
  const status = await runtime.execute(action('wave0-git-status', 'git.status', { cwd: root }), permission);
  assert.equal(status.ok, true, status.error?.message);
  const entries = (status.output as any).entries as Array<{path: string}>;
  assert.equal(entries.some(x => x.path === target), true);
  const diff = await runtime.execute(action('wave0-git-diff', 'git.diff', {
    cwd: root, paths: [target], publicLiteralFiles: true
  }), permission);
  assert.equal(diff.ok, true, diff.error?.message);
  const reported = String((diff.output as any).stdout);
  const independentDiff = git(root, 'diff', '--no-ext-diff', '--', target);
  assert.match(reported, /\+customer=v2/);
  assert.match(reported, /-customer=v1/);
  assert.match(independentDiff, /\+customer=v2/);
  assert.equal(await fs.readFile(path.join(root, target), 'utf8'), 'customer=v2\n');
  assert.equal(git(root, 'rev-parse', 'HEAD').trim(), baselineSha);
});

gitTest('C01 Lane B runtime refuses out-of-root Git inspection and does not create new state', async t => {
  const { root, outside, runtime, permission, action } = await fixture(t);
  const baselineStatus = git(root, 'status', '--porcelain');
  const result = await runtime.execute(action('wave0-git-outside', 'git.status', {
    cwd: outside
  }), permission);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'PATH_OUTSIDE_SCOPE');
  assert.equal(git(root, 'status', '--porcelain'), baselineStatus);
});

gitTest('C01 Lane B disallowed terminal action cannot escalate Git read-only intent', async t => {
  const { root, runtime, permission } = await fixture(t);
  const result = await runtime.execute({
    id: 'wave0-git-unapproved-command', capability: 'terminal.execute',
    risk: 'destructive', provenance: { kind: 'user' },
    input: { executable: 'git', args: ['reset', '--hard', 'HEAD'], cwd: root }
  }, permission);
  assert.equal(result.ok, false);
  assert.equal(result.provider, 'policy');
  assert.equal(result.error?.code, 'CAPABILITY_DENIED');
  assert.equal(git(root, 'status', '--porcelain'), '');
});

gitTest('C01 Lane B restricted Git files cannot be read through public literal diff', async t => {
  const { root, runtime, permission, action } = await fixture(t);
  await fs.writeFile(path.join(root, '.env'), 'synthetic-no-secret=1\n');
  const result = await runtime.execute(action('wave0-git-restricted', 'git.diff', {
    cwd: root, paths: ['.env'], publicLiteralFiles: true
  }), permission);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'RESTRICTED_DATA_PATH_DENIED');
  assert.equal(JSON.stringify(result).includes('synthetic-no-secret=1'), false);
});
