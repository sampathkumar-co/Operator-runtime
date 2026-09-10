import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const suite = String(process.argv[2] ?? '').trim();
if (!suite || path.isAbsolute(suite) || suite.includes('\0') || suite === '..' || suite.startsWith(`..${path.sep}`)) {
  throw new Error('Test suite directory must be a safe repository-relative path.');
}

const root = process.cwd();
const directory = path.resolve(root, suite);
const relative = path.relative(root, directory);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
  throw new Error('Test suite directory must remain inside the repository.');
}

const names = (await fs.readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
  .map((entry) => entry.name)
  .sort();
if (names.length === 0) throw new Error(`No *.test.ts files found in ${suite}.`);

const files = names.map((name) => path.join(directory, name));
const exitCode = await new Promise<number>((resolve, reject) => {
  const child = spawn(process.execPath, ['--experimental-strip-types', '--test', ...files], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
    env: process.env
  });
  child.once('error', reject);
  child.once('close', (code, signal) => {
    if (signal) {
      reject(new Error(`Test runner terminated by signal ${signal}.`));
      return;
    }
    resolve(code ?? 1);
  });
});

process.exitCode = exitCode;
