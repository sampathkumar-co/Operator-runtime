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

async function publicDiff(provider: GitProvider, root: string, paths: string[]) {
  return provider.execute({
    id: `public-${paths.join('|') || 'empty'}`,
    capability: 'git.diff',
    risk: 'read',
    provenance: { kind: 'chatgpt' },
    input: { cwd: root, paths, publicLiteralFiles: true }
  });
}

test('public Git diff rejects the complete magic, traversal, absolute, directory, and empty corpus', async (t) => {
  const root = await createRepo(t);
  const provider = new GitProvider({ allowedRoots: [root] });
  const invalid = [
    ':(glob)**/.env',
    ':(icase).EnV',
    ':(exclude)src/a.txt',
    '!foo', '*', '**', '?', '[]', '{}',
    '../outside.txt',
    path.resolve(root, 'src', 'a.txt'),
    'src'
  ];
  for (const candidate of invalid) {
    const result = await publicDiff(provider, root, [candidate]);
    assert.equal(result.ok, false, `must reject ${candidate}`);
    assert.equal(result.error?.code, 'GIT_PUBLIC_PATH_FILTER_INVALID', candidate);
  }
  const empty = await publicDiff(provider, root, []);
  assert.equal(empty.ok, false);
  assert.equal(empty.error?.code, 'GIT_PUBLIC_PATH_FILTER_REQUIRED');
});

test('public Git diff rejects credential-bearing literal paths at the provider boundary', async (t) => {
  const root = await createRepo(t);
  const provider = new GitProvider({ allowedRoots: [root] });
  for (const candidate of [
    '.env',
    '.ssh/id_rsa',
    '.aws/credentials',
    'credentials.json',
    '.npmrc'
  ]) {
    const result = await publicDiff(provider, root, [candidate]);
    assert.equal(result.ok, false, `must reject ${candidate}`);
    assert.equal(result.error?.code, 'RESTRICTED_DATA_PATH_DENIED', candidate);
  }
});

test('public Git diff keeps literal filenames literal even when they resemble pathspec syntax', async (t) => {
  const root = await createRepo(t);
  const provider = new GitProvider({ allowedRoots: [root] });
  await fs.writeFile(path.join(root, 'src', 'safe.txt'), 'base\n');
  git(root, 'add', 'src/safe.txt');
  git(root, 'commit', '-m', 'add-safe');
  await fs.writeFile(path.join(root, 'src', 'safe.txt'), 'changed\n');
  await fs.writeFile(path.join(root, 'src', 'a.txt'), 'also changed\n');

  const result = await publicDiff(provider, root, ['src/safe.txt']);
  assert.equal(result.ok, true, result.error?.message);
  const stdout = String((result.output as any).stdout);
  assert.match(stdout, /src\/safe\.txt/);
  assert.equal(stdout.includes('src/a.txt'), false);
});
