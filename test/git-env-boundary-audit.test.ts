import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { supportedGitAvailable } from './git-test-support.ts';
import { GitCheckpointProvider } from '../src/capabilities/git-checkpoint.ts';
import { GitWriteProvider } from '../src/capabilities/git-write.ts';
const gitTest = supportedGitAvailable() ? test : test.skip;

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return await fs.realpath(dir);
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined }
  }).trim();
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function initRepo(root: string, content: string): Promise<void> {
  git(root, ['init']);
  git(root, ['config', 'user.name', 'Operator Test']);
  git(root, ['config', 'user.email', 'operator-test@example.invalid']);
  await fs.writeFile(path.join(root, 'state.txt'), content);
  git(root, ['add', 'state.txt']);
  git(root, ['commit', '-m', 'initial']);
}

test('all Git subprocess boundaries disable lazy promisor fetching twice', async () => {
  const readSource = await fs.readFile(path.resolve('src/capabilities/git.ts'), 'utf8');
  const checkpointSource = await fs.readFile(path.resolve('src/capabilities/git-checkpoint.ts'), 'utf8');
  const writeSource = await fs.readFile(path.resolve('src/capabilities/git-write.ts'), 'utf8');
  for (const source of [readSource, checkpointSource, writeSource]) {
    assert.match(source, /GIT_NO_LAZY_FETCH:\s*'1'/);
    assert.match(source, /'--no-lazy-fetch'/);
  }
});

gitTest('Git checkpoint ignores ambient GIT_DIR/GIT_WORK_TREE redirection', async (t) => {
  const allowed = await tempDir(t, 'operator-git-env-allowed-');
  const outside = await tempDir(t, 'operator-git-env-outside-');
  await initRepo(allowed, 'allowed\n');
  await initRepo(outside, 'outside\n');

  const previousDir = process.env.GIT_DIR;
  const previousTree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = path.join(outside, '.git');
  process.env.GIT_WORK_TREE = outside;
  t.after(() => {
    restoreEnv('GIT_DIR', previousDir);
    restoreEnv('GIT_WORK_TREE', previousTree);
  });

  const provider = new GitCheckpointProvider({ allowedRoots: [allowed] });
  const result = await provider.execute({
    id: 'git-env-checkpoint',
    capability: 'git.checkpoint.create',
    risk: 'write',
    input: { cwd: allowed, label: 'ambient Git routing must be ignored' },
    provenance: { kind: 'chatgpt' }
  });

  assert.equal(result.ok, true, result.error?.message);
  assert.equal((result.output as { root: string }).root, allowed);
  assert.equal(await fs.readFile(path.join(allowed, 'state.txt'), 'utf8'), 'allowed\n');
  assert.equal(await fs.readFile(path.join(outside, 'state.txt'), 'utf8'), 'outside\n');
});


gitTest('Git checkpoint ignores caller-controlled XDG global filter configuration', async (t) => {
  const root = await tempDir(t, 'operator-git-xdg-root-');
  const xdg = await tempDir(t, 'operator-git-xdg-config-');
  await initRepo(root, 'safe content\n');
  const marker = path.join(root, 'xdg-filter-ran.marker');
  const script = path.join(root, 'xdg-filter.cjs');
  await fs.writeFile(script, `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdin.pipe(process.stdout);\n`);
  await fs.writeFile(path.join(root, '.gitattributes'), '*.txt filter=operator-xdg\n');
  git(root, ['add', '.gitattributes', 'xdg-filter.cjs']);
  git(root, ['commit', '-m', 'add xdg filter fixture']);
  await fs.mkdir(path.join(xdg, 'git'), { recursive: true });
  const command = `node ${script.replace(/\\/g, '/')}`;
  await fs.writeFile(path.join(xdg, 'git', 'config'), `[filter "operator-xdg"]\n\tclean = ${command}\n\tsmudge = ${command}\n`);
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  t.after(() => restoreEnv('XDG_CONFIG_HOME', previous));

  const provider = new GitCheckpointProvider({ allowedRoots: [root] });
  const result = await provider.execute({
    id: 'git-xdg-checkpoint', capability: 'git.checkpoint.create', risk: 'write',
    input: { cwd: root, label: 'xdg config must be ignored' }, provenance: { kind: 'chatgpt' }
  });
  assert.equal(result.ok, true, result.error?.message);
  await assert.rejects(fs.access(marker));
});


gitTest('Git checkpoint and write ignore HOME global filters and global commit identity', async (t) => {
  const root = await tempDir(t, 'operator-git-home-root-');
  const home = await tempDir(t, 'operator-git-home-config-');
  await initRepo(root, 'safe content\n');
  const marker = path.join(root, 'home-filter-ran.marker');
  const script = path.join(root, 'home-filter.cjs');
  await fs.writeFile(script, `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdin.pipe(process.stdout);\n`);
  await fs.writeFile(path.join(root, '.gitattributes'), '*.txt filter=operator-home\n');
  git(root, ['add', '.gitattributes', 'home-filter.cjs']);
  git(root, ['commit', '-m', 'add home filter fixture']);
  git(root, ['config', '--unset', 'user.name']);
  git(root, ['config', '--unset', 'user.email']);
  const command = `node ${script.replace(/\\/g, '/')}`;
  await fs.writeFile(path.join(home, '.gitconfig'), `[user]\n\tname = Attacker Global\n\temail = attacker@example.invalid\n[filter "operator-home"]\n\tclean = ${command}\n\tsmudge = ${command}\n`);
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => { restoreEnv('HOME', previousHome); restoreEnv('USERPROFILE', previousProfile); });

  await fs.writeFile(path.join(root, 'state.txt'), 'changed safely\n');
  const checkpoint = new GitCheckpointProvider({ allowedRoots: [root] });
  const created = await checkpoint.execute({ id: 'home-filter-checkpoint', capability: 'git.checkpoint.create', risk: 'write', input: { cwd: root }, provenance: { kind: 'chatgpt' } });
  assert.equal(created.ok, true, created.error?.message);
  await assert.rejects(fs.access(marker));

  const writer = new GitWriteProvider({ allowedRoots: [root] });
  const staged = await writer.execute({ id: 'home-filter-stage', capability: 'git.write', risk: 'write', input: { operation: 'stage', cwd: root, paths: ['state.txt'], expectedCurrentFingerprint: String((created.output as any).fingerprint) }, provenance: { kind: 'chatgpt' } });
  assert.equal(staged.ok, true, staged.error?.message);
  await assert.rejects(fs.access(marker));


  const inspected = await checkpoint.execute({ id: 'home-filter-inspect', capability: 'git.checkpoint.inspect', risk: 'read', input: { cwd: root }, provenance: { kind: 'runtime' } });
  assert.equal(inspected.ok, true, inspected.error?.message);
  const committed = await writer.execute({ id: 'home-filter-commit', capability: 'git.write', risk: 'write', input: { operation: 'commit', cwd: root, message: 'test: isolated global config', expectedCurrentFingerprint: String((inspected.output as any).current.fingerprint) }, provenance: { kind: 'chatgpt' } });
  assert.equal(committed.ok, true, committed.error?.message);
  await assert.rejects(fs.access(marker));
  restoreEnv('HOME', previousHome);
  restoreEnv('USERPROFILE', previousProfile);
  assert.equal(git(root, ['log', '-1', '--pretty=%an%x00%ae']).trim(), 'Operator\0operator@local.invalid');
});


gitTest('Git checkpoint rejects content filters loaded through repository config includes', async (t) => {
  const root = await tempDir(t, 'operator-git-include-root-');
  await initRepo(root, 'safe content\n');
  const marker = path.join(root, 'include-filter-ran.marker');
  const script = path.join(root, 'include-filter.cjs');
  const included = path.join(root, 'included-git-config');
  await fs.writeFile(script, `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdin.pipe(process.stdout);\n`);
  await fs.writeFile(path.join(root, '.gitattributes'), '*.txt filter=operator-include\n');
  git(root, ['add', '.gitattributes', 'include-filter.cjs']);
  git(root, ['commit', '-m', 'add include filter fixture']);
  const command = `node ${script.replace(/\\/g, '/')}`;
  await fs.writeFile(included, `[filter "operator-include"]\n\tclean = ${command}\n\tsmudge = ${command}\n`);
  git(root, ['config', '--local', 'include.path', included.replace(/\\/g, '/')]);

  const provider = new GitCheckpointProvider({ allowedRoots: [root] });
  const result = await provider.execute({ id: 'included-filter-denied', capability: 'git.checkpoint.create', risk: 'write', input: { cwd: root }, provenance: { kind: 'chatgpt' } });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'GIT_LOCAL_FILTER_DENIED');
  await assert.rejects(fs.access(marker));
});


gitTest('Git checkpoint and write disable repository hooks for index-changing operations', async (t) => {
  const root = await tempDir(t, 'operator-git-hooks-root-');
  await initRepo(root, 'safe content\n');
  const hooks = path.join(root, 'evil-hooks');
  const marker = path.join(root, 'post-index-change.marker');
  await fs.mkdir(hooks, { recursive: true });
  const hook = path.join(hooks, 'post-index-change');
  await fs.writeFile(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker.replace(/\\/g, '/'))}\nexit 0\n`);
  await fs.chmod(hook, 0o755);
  git(root, ['config', '--local', 'core.hooksPath', hooks.replace(/\\/g, '/')]);
  await fs.writeFile(path.join(root, 'state.txt'), 'changed safely\n');

  const checkpoint = new GitCheckpointProvider({ allowedRoots: [root] });
  const created = await checkpoint.execute({ id: 'hook-checkpoint', capability: 'git.checkpoint.create', risk: 'write', input: { cwd: root }, provenance: { kind: 'chatgpt' } });
  assert.equal(created.ok, true, created.error?.message);
  await assert.rejects(fs.access(marker));

  const writer = new GitWriteProvider({ allowedRoots: [root] });
  const staged = await writer.execute({ id: 'hook-stage', capability: 'git.write', risk: 'write', input: { operation: 'stage', cwd: root, paths: ['state.txt'], expectedCurrentFingerprint: String((created.output as any).fingerprint) }, provenance: { kind: 'chatgpt' } });
  assert.equal(staged.ok, true, staged.error?.message);
  await assert.rejects(fs.access(marker));
});

gitTest('Git checkpoint disables reference-transaction hooks during ref updates', async (t) => {
  const root = await tempDir(t, 'operator-git-ref-hook-root-');
  await initRepo(root, 'safe content\n');
  const hooks = path.join(root, 'evil-ref-hooks');
  const marker = path.join(root, 'reference-transaction.marker');
  await fs.mkdir(hooks, { recursive: true });
  const hook = path.join(hooks, 'reference-transaction');
  await fs.writeFile(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker.replace(/\\/g, '/'))}\ncat >/dev/null\nexit 0\n`);
  await fs.chmod(hook, 0o755);
  git(root, ['config', '--local', 'core.hooksPath', hooks.replace(/\\/g, '/')]);
  await fs.writeFile(path.join(root, 'state.txt'), 'changed safely\n');

  const checkpoint = new GitCheckpointProvider({ allowedRoots: [root] });
  const created = await checkpoint.execute({
    id: 'reference-hook-checkpoint', capability: 'git.checkpoint.create', risk: 'write',
    input: { cwd: root }, provenance: { kind: 'chatgpt' }
  });
  assert.equal(created.ok, true, created.error?.message);
  await assert.rejects(fs.access(marker));
});

gitTest('Git checkpoint ignores an authorized cwd git.exe shadow binary', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows cwd-first executable lookup regression');
  const root = await tempDir(t, 'operator-git-shadow-root-');
  await initRepo(root, 'safe content\n');
  const systemRoot = process.env.SYSTEMROOT ?? process.env.WINDIR;
  assert.ok(systemRoot, 'Windows system root is required for the shadow fixture');
  await fs.copyFile(path.join(systemRoot, 'System32', 'where.exe'), path.join(root, 'git.exe'));
  await fs.appendFile(path.join(root, '.git', 'info', 'exclude'), '\ngit.exe\n');

  const provider = new GitCheckpointProvider({ allowedRoots: [root] });
  const result = await provider.execute({
    id: 'git-shadow-checkpoint', capability: 'git.checkpoint.create', risk: 'write',
    input: { cwd: root, label: 'cwd shadow must be ignored' }, provenance: { kind: 'chatgpt' }
  });
  assert.equal(result.ok, true, result.error?.message);
});
