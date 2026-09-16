import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GitCheckpointProvider } from '../src/capabilities/git-checkpoint.ts';

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

test('Git checkpoint ignores ambient GIT_DIR/GIT_WORK_TREE redirection', async (t) => {
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


test('Git checkpoint ignores caller-controlled XDG global filter configuration', async (t) => {
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
