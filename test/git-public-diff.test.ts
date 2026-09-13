import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GitProvider } from '../src/capabilities/git.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function createRepo(t: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-git-public-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Operator CI');
  git(root, 'config', 'user.email', 'operator-ci@example.invalid');
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'a.txt'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  return root;
}

test('public Git diff accepts an explicit literal file and rejects directory expansion', async (t) => {
  const root = await createRepo(t);
  const provider = new GitProvider({ allowedRoots: [root] });
  await fs.writeFile(path.join(root, 'src', 'a.txt'), 'changed\n');

  const explicit = await provider.execute({
    id: 'explicit', capability: 'git.diff', risk: 'read', provenance: { kind: 'chatgpt' },
    input: { cwd: root, paths: ['src/a.txt'], publicLiteralFiles: true }
  });
  assert.equal(explicit.ok, true, explicit.error?.message);
  assert.match(String((explicit.output as any).stdout), /changed/);

  const directory = await provider.execute({
    id: 'directory', capability: 'git.diff', risk: 'read', provenance: { kind: 'chatgpt' },
    input: { cwd: root, paths: ['src'], publicLiteralFiles: true }
  });
  assert.equal(directory.ok, false);
  assert.equal(directory.error?.code, 'GIT_PUBLIC_PATH_FILTER_INVALID');
});
