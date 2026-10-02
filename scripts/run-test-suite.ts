import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const selectors = process.argv.slice(2).map((value) => String(value).trim()).filter(Boolean);
if (selectors.length === 0) {
  throw new Error('At least one repository-relative test directory or *.test.ts file is required.');
}

const root = process.cwd();

function resolveInsideRoot(selector: string): string {
  if (path.isAbsolute(selector) || selector.includes('\0') || selector === '..') {
    throw new Error(`Test selector must be a safe repository-relative path: ${selector}`);
  }
  const resolved = path.resolve(root, selector);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Test selector must remain inside the repository: ${selector}`);
  }
  return resolved;
}

const collected = new Set<string>();
for (const selector of selectors) {
  const resolved = resolveInsideRoot(selector);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new Error(`Test selector does not exist: ${selector}`);
  }

  if (stat.isDirectory()) {
    const names = (await fs.readdir(resolved, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
      .map((entry) => entry.name)
      .sort();
    for (const name of names) collected.add(path.join(resolved, name));
    continue;
  }

  if (stat.isFile() && resolved.endsWith('.test.ts')) {
    collected.add(resolved);
    continue;
  }

  throw new Error(`Test selector must be a directory or *.test.ts file: ${selector}`);
}

const files = [...collected].sort();
if (files.length === 0) throw new Error('No *.test.ts files matched the requested selectors.');

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
    // Individual tests fail closed with WINDOWS_PATH_LEASE_HELPER_REQUIRED when they require the helper.
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
  if (batches.length > 1) {
    process.stdout.write(`\n# test batch ${index + 1}/${batches.length} (${batches[index]!.length} files)\n`);
  }
  exitCode = await runBatch(batches[index]!);
  if (exitCode !== 0) break;
}
process.exitCode = exitCode;
