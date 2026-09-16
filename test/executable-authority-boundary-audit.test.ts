import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { resolveTrustedExecutable } from '../src/core/trusted-executable.ts';

const DIRECT_BOUNDARIES = [
  'src/capabilities/git-checkpoint.ts',
  'src/capabilities/git-write.ts',
  'src/capabilities/docker.ts',
  'src/capabilities/postgres.ts',
  'src/capabilities/vscode.ts'
] as const;

test('direct subprocess boundaries pin an absolute trusted executable before spawn', async () => {
  for (const relative of DIRECT_BOUNDARIES) {
    const source = await fs.readFile(path.resolve(relative), 'utf8');
    assert.match(source, /resolveTrustedExecutable\(/, `${relative} must resolve executable authority`);
  }
  const processSource = await fs.readFile(path.resolve('src/capabilities/process.ts'), 'utf8');
  assert.match(processSource, /resolveTrustedExecutable\(executable, childEnvironment\)/);
});

test('trusted executable resolver rejects relative paths and Windows command scripts', () => {
  assert.throws(() => resolveTrustedExecutable(`.${path.sep}git`), /Relative executable paths are not allowed/);
  if (process.platform === 'win32') {
    assert.throws(() => resolveTrustedExecutable('npm.cmd'), /command scripts are not valid/);
  }
});
