import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_FILE_BYTES = 512 * 1024 * 1024;
const SAFE_ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT',
  'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'TEMP', 'TMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'PLAYWRIGHT_BROWSERS_PATH'
] as const;

export type BenchmarkBinding = {
  root: string;
  python: string;
  pythonSha256: string;
  script: string;
  scriptSha256: string;
};

export async function validateBenchmarkBinding(input: BenchmarkBinding): Promise<BenchmarkBinding> {
  const root = await canonicalDirectory(input.root, 'benchmark root');
  const python = await canonicalRegularFile(input.python, 'benchmark Python');
  const script = await canonicalRegularFile(input.script, 'benchmark controller');
  if (!inside(python, root) || !inside(script, root)) {
    throw new Error('Benchmark Python and controller must remain inside the registered benchmark root.');
  }
  if (path.basename(python).toLowerCase() !== 'python.exe') {
    throw new Error('Registered benchmark Python must be a python.exe inside the benchmark root.');
  }
  if (path.extname(script).toLowerCase() !== '.py') {
    throw new Error('Registered benchmark controller must be a .py file inside the benchmark root.');
  }
  const pythonSha256 = validSha(input.pythonSha256, 'Python SHA-256');
  const scriptSha256 = validSha(input.scriptSha256, 'controller SHA-256');
  if (await sha256Bounded(python) !== pythonSha256) {
    throw new Error('Registered benchmark Python SHA-256 no longer matches.');
  }
  if (await sha256Bounded(script) !== scriptSha256) {
    throw new Error('Registered benchmark controller SHA-256 no longer matches.');
  }
  return { root, python, pythonSha256, script, scriptSha256 };
}

export function parseBenchmarkRunnerArgs(argv: string[]): BenchmarkBinding {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key || !value || !['--root', '--python', '--python-sha256', '--script', '--script-sha256'].includes(key)) {
      throw new Error('Invalid signed benchmark-runner arguments.');
    }
    if (values.has(key)) throw new Error('Duplicate signed benchmark-runner argument.');
    values.set(key, value);
  }
  if (values.size !== 5) throw new Error('Signed benchmark-runner arguments are incomplete.');
  return {
    root: values.get('--root')!,
    python: values.get('--python')!,
    pythonSha256: values.get('--python-sha256')!,
    script: values.get('--script')!,
    scriptSha256: values.get('--script-sha256')!
  };
}

export async function runRegisteredBenchmark(argv: string[]): Promise<number> {
  const binding = await validateBenchmarkBinding(parseBenchmarkRunnerArgs(argv));
  const child = spawn(binding.python, [binding.script], {
    cwd: binding.root,
    shell: false,
    windowsHide: false,
    stdio: 'inherit',
    env: safeBenchmarkEnvironment(process.env)
  });
  const forward = (signal: NodeJS.Signals) => {
    try { child.kill(signal); } catch { /* child may already be gone */ }
  };
  process.once('SIGINT', forward);
  process.once('SIGTERM', forward);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (signal) reject(new Error(`Registered benchmark controller terminated by signal ${signal}.`));
        else resolve(code ?? 1);
      });
    });
  } finally {
    process.removeListener('SIGINT', forward);
    process.removeListener('SIGTERM', forward);
  }
}

function safeBenchmarkEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) if (source[key] !== undefined) env[key] = source[key];
  return env;
}

async function canonicalDirectory(input: string, label: string): Promise<string> {
  const absolute = path.resolve(String(input ?? ''));
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a real directory.`);
  return await fs.realpath(absolute);
}

async function canonicalRegularFile(input: string, label: string): Promise<string> {
  const absolute = path.resolve(String(input ?? ''));
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > MAX_FILE_BYTES) {
    throw new Error(`${label} must be a bounded regular file.`);
  }
  const real = await fs.realpath(absolute);
  const realStat = await fs.lstat(real);
  if (!realStat.isFile() || realStat.size !== stat.size) throw new Error(`${label} changed during validation.`);
  return real;
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validSha(input: string, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

async function sha256Bounded(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    if (bytes > MAX_FILE_BYTES) throw new Error('Registered benchmark file exceeds the hash bound.');
    hash.update(chunk);
  }
  return hash.digest('hex');
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url : false;
if (invoked) {
  runRegisteredBenchmark(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`[mecord-benchmark] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
