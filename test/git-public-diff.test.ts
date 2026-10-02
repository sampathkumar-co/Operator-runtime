import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { supportedGitAvailable } from './git-test-support.ts';
import { GitProvider } from '../src/capabilities/git.ts';
const gitTest = supportedGitAvailable() ? test : test.skip;

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

gitTest('public Git diff accepts an explicit literal file and rejects directory expansion', async (t) => {
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

gitTest('Git diff and status paginate before relay serialization', async (t) => {
  const root = await createRepo(t);
  const provider = new GitProvider({ allowedRoots: [root] });
  await fs.writeFile(path.join(root, 'src', 'a.txt'), Array.from({ length: 12_000 }, (_, index) => `changed-${index}-${'x'.repeat(20)}`).join('\n'));
  let offset = 0;
  let combined = '';
  do {
    const result = await provider.execute({
      id: `paged-${offset}`, capability: 'git.diff', risk: 'read', provenance: { kind: 'runtime' },
      input: { cwd: root, paths: ['src/a.txt'], offset, maxBytes: 32 * 1024 }
    });
    assert.equal(result.ok, true, result.error?.message);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 256 * 1024);
    const output = result.output as any;
    combined += output.stdout;
    if (!output.truncated) break;
    assert.ok(output.nextOffset > offset);
    offset = output.nextOffset;
  } while (true);
  assert.match(combined, /changed-11999/);

  for (let index = 0; index < 400; index += 1) await fs.writeFile(path.join(root, `untracked-${String(index).padStart(4, '0')}-${'n'.repeat(80)}.txt`), 'x');
  const status = await provider.execute({
    id: 'status-page', capability: 'git.status', risk: 'read', provenance: { kind: 'runtime' }, input: { cwd: root, maxBytes: 8 * 1024 }
  });
  assert.equal(status.ok, true, status.error?.message);
  assert.equal((status.output as any).truncated, true);
  assert.ok((status.output as any).nextOffset > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(status), 'utf8') < 256 * 1024);
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

gitTest('public Git diff rejects the complete magic, traversal, absolute, directory, and empty corpus', async (t) => {
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

gitTest('public Git diff rejects credential-bearing literal paths at the provider boundary', async (t) => {
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

gitTest('read-only Git status disables repository post-index-change hooks', async (t) => {
  const root = await createRepo(t);
  const provider = new GitProvider({ allowedRoots: [root] });
  const hooks = path.join(root, 'operator-hooks');
  const marker = path.join(root, 'status-hook.marker');
  await fs.mkdir(hooks);
  await fs.writeFile(path.join(hooks, 'post-index-change'), `#!/bin/sh\nprintf ran > "${marker.replace(/\\/g, '/')}"\nexit 0\n`);
  await fs.chmod(path.join(hooks, 'post-index-change'), 0o755);
  git(root, 'config', 'core.hooksPath', hooks);
  await fs.writeFile(path.join(root, 'src', 'a.txt'), 'changed\n');
  const result = await provider.execute({ id: 'status-hook', capability: 'git.status', risk: 'read', provenance: { kind: 'chatgpt' }, input: { cwd: root } });
  assert.equal(result.ok, true, result.error?.message);
  await assert.rejects(fs.access(marker));
});

gitTest('read-only Git diff rejects repository content filters before they can execute', async (t) => {
  const root = await createRepo(t);
  const provider = new GitProvider({ allowedRoots: [root] });
  const marker = path.join(root, 'local-filter.marker');
  const command = await writeFilterScript(root, marker);
  await fs.writeFile(path.join(root, '.gitattributes'), 'src/a.txt filter=evil\n');
  git(root, 'add', '.gitattributes');
  git(root, 'commit', '-m', 'attributes');
  git(root, 'config', 'filter.evil.clean', command);
  await fs.writeFile(path.join(root, 'src', 'a.txt'), 'changed\n');
  const result = await provider.execute({ id: 'diff-filter', capability: 'git.diff', risk: 'read', provenance: { kind: 'chatgpt' }, input: { cwd: root, paths: ['src/a.txt'] } });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'GIT_CONTENT_FILTER_DENIED');
  await assert.rejects(fs.access(marker));
});

gitTest('read-only Git diff ignores HOME global filter configuration', async (t) => {
  const root = await createRepo(t);
  const provider = new GitProvider({ allowedRoots: [root] });
  const marker = path.join(root, 'global-filter.marker');
  const command = await writeFilterScript(root, marker);
  await fs.writeFile(path.join(root, '.gitattributes'), 'src/a.txt filter=evil\n');
  git(root, 'add', '.gitattributes');
  git(root, 'commit', '-m', 'attributes');
  const fakeHome = path.join(root, 'fake-home');
  await fs.mkdir(fakeHome);
  execFileSync('git', ['config', '--file', path.join(fakeHome, '.gitconfig'), 'filter.evil.clean', command], { cwd: root });
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
  });
  await fs.writeFile(path.join(root, 'src', 'a.txt'), 'changed\n');
  const result = await provider.execute({ id: 'diff-global-filter', capability: 'git.diff', risk: 'read', provenance: { kind: 'chatgpt' }, input: { cwd: root, paths: ['src/a.txt'] } });
  assert.equal(result.ok, true, result.error?.message);
  await assert.rejects(fs.access(marker));
});

function quoteGitCommandPath(value: string): string {
  return `"${value.replace(/\\/g, '/').replace(/"/g, '\"')}"`;
}

async function writeFilterScript(root: string, marker: string): Promise<string> {
  const script = path.join(root, 'operator-evil-filter.mjs');
  await fs.writeFile(script, [
    "import fs from 'node:fs';",
    `const marker = ${JSON.stringify(marker)};`,
    'const chunks = [];',
    "process.stdin.on('data', (chunk) => chunks.push(chunk));",
    "process.stdin.on('end', () => { fs.writeFileSync(marker, 'ran'); process.stdout.write(Buffer.concat(chunks)); });"
  ].join('\n'));
  return `${quoteGitCommandPath(process.execPath)} ${quoteGitCommandPath(script)}`;
}

gitTest('read-only Git diff disables lazy promisor fetch helpers', async (t) => {
  const root = await createRepo(t);
  const provider = new GitProvider({ allowedRoots: [root] });
  const marker = path.join(root, 'lazy-fetch.marker');
  const helper = path.join(root, 'lazy-fetch-helper.cjs');
  await fs.writeFile(helper, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.exit(1);\n`);
  git(root, 'config', 'remote.origin.url', `ext::node ${helper.replace(/\\/g, '/')}`);
  git(root, 'config', 'remote.origin.promisor', 'true');
  git(root, 'config', 'remote.origin.partialclonefilter', 'blob:none');
  git(root, 'config', 'protocol.ext.allow', 'always');
  const blob = git(root, 'rev-parse', 'HEAD:src/a.txt').trim();
  const objectPath = path.join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
  await fs.access(objectPath);
  await fs.rm(objectPath);
  await fs.writeFile(path.join(root, 'src', 'a.txt'), 'changed\n');
  const result = await provider.execute({ id: 'lazy-diff', capability: 'git.diff', risk: 'read', provenance: { kind: 'chatgpt' }, input: { cwd: root, paths: ['src/a.txt'] } });
  assert.equal(result.ok, false);
  await assert.rejects(fs.access(marker));
});

gitTest('public Git diff keeps literal filenames literal even when they resemble pathspec syntax', async (t) => {
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
