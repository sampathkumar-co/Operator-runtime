import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { assertSupportedGitVersionText, resolveTrustedExecutable } from '../src/core/trusted-executable.ts';

const DIRECT_BOUNDARIES = [
  'src/capabilities/docker.ts',
  'src/capabilities/postgres.ts',
  'src/capabilities/vscode.ts'
] as const;

test('direct subprocess boundaries pin an absolute trusted executable before spawn', async () => {
  for (const relative of ['src/capabilities/git-checkpoint.ts', 'src/capabilities/git-write.ts']) {
    const source = await fs.readFile(path.resolve(relative), 'utf8');
    assert.match(source, /resolveSupportedGitExecutable\(/, `${relative} must require supported absolute Git authority`);
  }
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


test('Git 2.45+ is required for the fail-closed no-lazy-fetch boundary', () => {
  assert.deepEqual(assertSupportedGitVersionText('git version 2.45.0'), { major: 2, minor: 45, patch: 0 });
  assert.deepEqual(assertSupportedGitVersionText('git version 2.48.1.windows.1'), { major: 2, minor: 48, patch: 1 });
  assert.throws(() => assertSupportedGitVersionText('git version 2.43.0'), (error: unknown) =>
    error instanceof Error && (error as Error & { code?: string }).code === 'GIT_VERSION_UNSUPPORTED');
  assert.throws(() => assertSupportedGitVersionText('git version unknown'), (error: unknown) =>
    error instanceof Error && (error as Error & { code?: string }).code === 'GIT_VERSION_CHECK_FAILED');
});
