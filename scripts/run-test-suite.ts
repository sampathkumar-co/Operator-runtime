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
const MAX_ARG_CHARS = process.platform === 'win32' ? 7_000 : 64_000;
const batches: string[][] = [];
let batch: string[] = [];
let batchChars = 0;
for (const file of files) {
  const nextChars = file.length + 3;
  if (batch.length > 0 && batchChars + nextChars > MAX_ARG_CHARS) {
    batches.push(batch);
    batch = [];
    batchChars = 0;
  }
  batch.push(file);
  batchChars += nextChars;
}
if (batch.length > 0) batches.push(batch);

const childEnv = { ...process.env };
if (process.platform === 'win32' && !childEnv.OPERATOR_WINDOWS_PATH_LEASE_PATH) {
  const helper = path.resolve(root, 'native/windows-path-lease/target/release/operator-windows-path-lease.exe');
  try {
    await fs.access(helper);
    childEnv.OPERATOR_WINDOWS_PATH_LEASE_PATH = helper;
  } catch {
    // Individual tests will fail closed with WINDOWS_PATH_LEASE_HELPER_REQUIRED.
  }
}

async function runBatch(batchFiles: string[]): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--test', ...batchFiles], {
      cwd: root,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
      env: childEnv
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
}

let exitCode = 0;
for (let index = 0; index < batches.length; index += 1) {
  if (batches.length > 1) process.stdout.write(`\n# test batch ${index + 1}/${batches.length} (${batches[index]!.length} files)\n`);
  exitCode = await runBatch(batches[index]!);
  if (exitCode !== 0) break;
}
process.exitCode = exitCode;
