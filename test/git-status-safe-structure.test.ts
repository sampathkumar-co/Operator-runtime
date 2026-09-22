import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GitProvider } from '../src/capabilities/git.ts';
import { containsRestrictedData } from '../src/core/public-restricted-data.ts';

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

test('git.status returns safe structured porcelain without raw mode metadata', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-git-status-safe-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Operator CI');
  git(root, 'config', 'user.email', 'operator-ci@example.invalid');
  await fs.writeFile(path.join(root, 'a.txt'), 'base\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '-m', 'base');
  await fs.writeFile(path.join(root, 'a.txt'), 'changed\n');

  const provider = new GitProvider({ allowedRoots: [root] });
  const result = await provider.execute({
    id: 'status-safe',
    capability: 'git.status',
    risk: 'read',
    input: { cwd: root },
    provenance: { kind: 'chatgpt' }
  });
  assert.equal(result.ok, true, result.error?.message);
  const output = result.output as any;
  assert.equal(Object.hasOwn(output, 'stdout'), false);
  assert.equal(output.branch, 'main');
  assert.equal(output.clean, false);
  assert.equal(Array.isArray(output.entries), true);
  assert.equal(output.entries.some((entry: any) => entry.path === 'a.txt'), true);
  assert.equal(containsRestrictedData(result), false);
});
