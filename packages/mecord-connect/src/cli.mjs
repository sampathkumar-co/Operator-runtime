import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalApprovalConsole, validateLocalAgentReadyMessage } from './approval-console.mjs';

const PACKAGE_NAME = 'mecord-connect';
const RELAY_URL = 'wss://operator.splcart.in/device';
const RELAY_RESULT_URL = 'https://operator.splcart.in/v1/device-result';
const PAIR_URL_BASE = 'https://auth.splcart.in/pair';
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(packageRoot, 'runtime');
const manifestPath = path.join(runtimeRoot, 'runtime-manifest.json');
const remoteEntrypoint = path.join(runtimeRoot, 'app', 'apps', 'local-agent', 'src', 'remote.js');
const benchmarkRunnerEntrypoint = path.join(runtimeRoot, 'app', 'apps', 'local-agent', 'src', 'benchmark-runner.js');
const helperPath = (name) => path.join(runtimeRoot, 'native', name);

const DESKTOP_ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'WINDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'USER', 'USERNAME', 'LOGNAME', 'TMP', 'TEMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'SHELL',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROGRAMDATA',
  'LOCALAPPDATA', 'APPDATA', 'DISPLAY', 'WAYLAND_DISPLAY',
  'DBUS_SESSION_BUS_ADDRESS'
];
const WINDOWS_NATIVE_ENV_KEYS = [
  'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TMP', 'TEMP'
];
const REQUIRED_RUNTIME_FILES = [
  'app/apps/local-agent/src/remote.js',
  'app/apps/local-agent/src/benchmark-runner.js',
  'native/operator-windows-dpapi.exe',
  'native/operator-windows-uia.exe',
  'native/operator-windows-path-lease.exe'
];

function usage() {
  return `Mecord Connect

Usage:
  npx mecord-connect@latest remote [--root <folder>] [--no-browser]
  npx mecord-connect@latest benchmark-register --root <folder> --python <python.exe> --script <controller.py>
  npx mecord-connect@latest doctor
  npx mecord-connect@latest --help

remote starts the local policy/runtime agent and its secure relay connection only.
benchmark-register locally binds one exact benchmark Python + controller by SHA-256
into the protected trusted-command registry; it does not enable generic terminal access.
ChatGPT connects to the hosted MCP service; no local MCP server or MSIX install is required.
When an action needs approval, Mecord opens a local Windows card with Deny, Approve Once, and Allow Session.
Approval stays local and is never exposed to ChatGPT; terminal approval commands remain available as a fallback.
--no-browser disables automatic managed-Chromium launch for private browser tasks;
first-time account/device pairing still opens the secure authenticated pairing page when required.`;
}

export function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    return { command: 'help' };
  }
  if (argv[0] === 'doctor') {
    if (argv.length !== 1) throw new Error('doctor does not accept arguments.');
    return { command: 'doctor' };
  }
  if (argv[0] === 'benchmark-register') {
    const values = new Map();
    for (let index = 1; index < argv.length; index += 2) {
      const key = argv[index];
      const value = argv[index + 1];
      if (!['--root', '--python', '--script'].includes(key) || !value || values.has(key)) {
        throw new Error('benchmark-register requires exactly --root, --python, and --script.');
      }
      values.set(key, value);
    }
    if (values.size !== 3) throw new Error('benchmark-register requires exactly --root, --python, and --script.');
    return { command: 'benchmark-register', root: values.get('--root'), python: values.get('--python'), script: values.get('--script') };
  }
  if (argv[0] !== 'remote') throw new Error(`Unknown command '${argv[0]}'. Use --help.`);
  if (argv.length === 2 && (argv[1] === '--help' || argv[1] === '-h')) return { command: 'help' };
  let root = process.cwd();
  let browser = true;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-browser') {
      browser = false;
      continue;
    }
    if (arg === '--root') {
      const value = argv[++index];
      if (!value) throw new Error('--root requires a folder.');
      root = value;
      continue;
    }
    throw new Error(`Unknown remote option '${arg}'.`);
  }
  return { command: 'remote', root, browser };
}

export function validatePairingRequestMessage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.type !== 'mecord-pairing-required') return null;
  let url;
  try { url = new URL(String(input.url ?? '')); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'auth.splcart.in' || url.port || url.username || url.password || url.hash || url.pathname !== '/pair') return null;
  const keys = [...new Set([...url.searchParams.keys()])];
  if (keys.length !== 1 || keys[0] !== 'code') return null;
  const code = String(url.searchParams.get('code') ?? '').toUpperCase();
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(code)) return null;
  const expiresAt = String(input.expiresAt ?? '');
  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs) || new Date(expiryMs).toISOString() !== expiresAt || expiryMs <= Date.now()) return null;
  url.search = '';
  url.searchParams.set('code', code);
  return { url: url.toString(), expiresAt };
}

function openPairingPage(url, env) {
  const windowsRoot = String(env.SYSTEMROOT ?? env.WINDIR ?? '').trim();
  if (!/^[A-Za-z]:\\/.test(windowsRoot)) return false;
  const explorer = path.win32.join(windowsRoot, 'explorer.exe');
  try {
    const child = spawn(explorer, [url], {
      env: nativeEnvironment(env),
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: 'ignore'
    });
    child.once('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function assertSupportedRuntime(
  platform = process.platform,
  arch = process.arch,
  version = process.versions.node
) {
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error(`Mecord Connect remote currently requires Windows x64; received ${platform} ${arch}.`);
  }
  const parts = String(version).split('.').map(Number);
  if (parts.length < 2 || parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error('Unable to determine the Node.js version.');
  }
  const major = parts[0];
  const supported = (major === 22 && parts[1] >= 14) || major === 24 || major === 26;
  if (!supported) {
    throw new Error(`Mecord Connect remote requires Node.js 22.14+, 24.x, or 26.x; received ${version}.`);
  }
}

function pickEnvironment(keys, source) {
  const env = {};
  for (const key of keys) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

export function safeRuntimeEnvironment(source = process.env) {
  return pickEnvironment(DESKTOP_ENV_KEYS, source);
}

function nativeEnvironment(source = process.env) {
  return pickEnvironment(WINDOWS_NATIVE_ENV_KEYS, source);
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function validRuntimeRelativePath(input) {
  const value = String(input ?? '');
  if (!value || value.includes('\\') || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value) {
    throw new Error('Runtime manifest contains an unsafe file path.');
  }
  if (value === '..' || value.startsWith('../') || value.includes('/../')) {
    throw new Error('Runtime manifest contains an unsafe file path.');
  }
  return value;
}

export function validateRuntimeManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Runtime manifest must be an object.');
  if (input.schemaVersion !== 1 || input.package !== PACKAGE_NAME) throw new Error('Runtime manifest identity is invalid.');
  if (input.platform !== 'win32' || input.arch !== 'x64') throw new Error('Runtime manifest platform is invalid.');
  if (!/^\d+\.\d+\.\d+$/.test(String(input.version ?? ''))) throw new Error('Runtime manifest version is invalid.');
  if (!/^[0-9a-f]{40}$/i.test(String(input.sourceCommit ?? ''))) throw new Error('Runtime manifest source commit is invalid.');
  if (!Array.isArray(input.files) || input.files.length < REQUIRED_RUNTIME_FILES.length || input.files.length > 4096) {
    throw new Error('Runtime manifest file list is invalid.');
  }
  const seen = new Set();
  const files = input.files.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Runtime manifest file entry is invalid.');
    const relativePath = validRuntimeRelativePath(entry.path);
    const sizeBytes = Number(entry.sizeBytes);
    const digest = String(entry.sha256 ?? '').toLowerCase();
    if (seen.has(relativePath)) throw new Error(`Runtime manifest contains duplicate path ${relativePath}.`);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 64 * 1024 * 1024) {
      throw new Error(`Runtime manifest size is invalid for ${relativePath}.`);
    }
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`Runtime manifest SHA-256 is invalid for ${relativePath}.`);
    seen.add(relativePath);
    return { path: relativePath, sizeBytes, sha256: digest };
  });
  for (const required of REQUIRED_RUNTIME_FILES) {
    if (!seen.has(required)) throw new Error(`Runtime manifest is missing ${required}.`);
  }
  return {
    schemaVersion: 1,
    package: PACKAGE_NAME,
    version: String(input.version),
    platform: 'win32',
    arch: 'x64',
    sourceCommit: String(input.sourceCommit).toLowerCase(),
    files
  };
}

async function listRuntimeFiles(root, relative = '') {
  const directory = path.join(root, ...relative.split('/').filter(Boolean));
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (next === 'runtime-manifest.json') continue;
    const full = path.join(root, ...next.split('/'));
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) throw new Error(`Runtime payload contains a symbolic link: ${next}.`);
    if (stat.isDirectory()) files.push(...await listRuntimeFiles(root, next));
    else if (stat.isFile()) files.push(next);
    else throw new Error(`Runtime payload contains an unsupported filesystem entry: ${next}.`);
  }
  return files;
}

export async function verifyRuntimePayload() {
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const manifest = validateRuntimeManifest(raw);
  const actualPaths = (await listRuntimeFiles(runtimeRoot)).sort();
  const expectedPaths = manifest.files.map((entry) => entry.path).sort();
  if (actualPaths.length !== expectedPaths.length || actualPaths.some((value, index) => value !== expectedPaths[index])) {
    throw new Error('Runtime payload file set does not match its signed-in-package manifest.');
  }
  for (const entry of manifest.files) {
    const file = path.join(runtimeRoot, ...entry.path.split('/'));
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size !== entry.sizeBytes) throw new Error(`Runtime payload size mismatch: ${entry.path}.`);
    if (await sha256(file) !== entry.sha256) throw new Error(`Runtime payload SHA-256 mismatch: ${entry.path}.`);
  }
  return manifest;
}

export function assertSerializableAuthorizedRoot(root) {
  const value = String(root ?? '');
  if (value.includes(path.win32.delimiter)) {
    throw new Error(`Authorized root cannot contain the Windows path-list delimiter '${path.win32.delimiter}'.`);
  }
  return value;
}

async function canonicalDirectory(input) {
  const resolved = path.resolve(input);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Authorized root is not a directory: ${resolved}`);
  return assertSerializableAuthorizedRoot(await fs.realpath(resolved));
}

export async function registerBenchmark({ root, python, script }) {
  assertSupportedRuntime();
  await verifyRuntimePayload();
  const benchmarkRoot = await canonicalDirectory(root);
  const pythonFile = await canonicalBenchmarkFile(benchmarkRoot, python, 'python.exe');
  const controllerFile = await canonicalBenchmarkFile(benchmarkRoot, script, '.py');
  const [pythonSha256, scriptSha256] = await Promise.all([sha256(pythonFile), sha256(controllerFile)]);
  const profile = trustedUserProfile(helperPath('operator-windows-path-lease.exe'));
  const stateDir = path.join(profile, '.operator');
  await ensureProtectedStateDirectory(stateDir);
  const registryPath = path.join(stateDir, 'project-commands.json');
  const registry = await readProjectCommandRegistry(registryPath);
  const command = {
    id: 'mecord-benchmark',
    title: 'Registered Mecord benchmark controller',
    kind: 'custom',
    executable: 'node',
    args: [
      benchmarkRunnerEntrypoint,
      '--root', benchmarkRoot,
      '--python', pythonFile,
      '--python-sha256', pythonSha256,
      '--script', controllerFile,
      '--script-sha256', scriptSha256
    ],
    cwd: '.',
    timeoutMs: 600000,
    risk: 'external',
    artifacts: []
  };
  const existing = registry.projects.find((entry) => sameWindowsPath(entry.root, benchmarkRoot));
  if (existing) {
    existing.root = benchmarkRoot;
    existing.commands = existing.commands.filter((item) => item?.id !== command.id);
    existing.commands.push(command);
  } else {
    registry.projects.push({ root: benchmarkRoot, commands: [command] });
  }
  registry.projects.sort((left, right) => String(left.root).localeCompare(String(right.root), 'en', { sensitivity: 'base' }));
  await writeProjectCommandRegistry(registryPath, registry);
  console.log('[mecord-connect] benchmark command registered locally');
  console.log(`[mecord-connect] benchmark root: ${benchmarkRoot}`);
  console.log('[mecord-connect] command id: mecord-benchmark');
  console.log('[mecord-connect] risk: external (local approval remains required)');
  return { root: benchmarkRoot, commandId: 'mecord-benchmark', pythonSha256, scriptSha256 };
}

async function canonicalBenchmarkFile(root, input, expectedSuffix) {
  const supplied = String(input ?? '');
  const absolute = path.isAbsolute(supplied) ? path.resolve(supplied) : path.resolve(root, supplied);
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > 512 * 1024 * 1024) {
    throw new Error('Benchmark registration accepts only bounded regular files.');
  }
  const real = await fs.realpath(absolute);
  const relative = path.relative(root, real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Benchmark Python and controller must remain inside the benchmark root.');
  }
  if (expectedSuffix === 'python.exe' && path.basename(real).toLowerCase() !== 'python.exe') {
    throw new Error('Benchmark Python must be a python.exe inside the benchmark root.');
  }
  if (expectedSuffix === '.py' && path.extname(real).toLowerCase() !== '.py') {
    throw new Error('Benchmark controller must be a .py file inside the benchmark root.');
  }
  return real;
}

function trustedUserProfile(helper) {
  let output;
  try {
    output = execFileSync(helper, ['system-roots'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 32 * 1024, env: {}
    });
  } catch {
    throw new Error('Mecord could not derive the trusted Windows user profile.');
  }
  const line = output.split(/\r?\n/).find((item) => item.startsWith('USERPROFILE='));
  const value = line?.slice('USERPROFILE='.length) ?? '';
  if (!path.win32.isAbsolute(value) || /[\0\r\n;]/.test(value)) throw new Error('Trusted Windows user profile is invalid.');
  return path.win32.normalize(value);
}

async function ensureProtectedStateDirectory(stateDir) {
  try {
    const stat = await fs.lstat(stateDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Protected Mecord state path is not a real directory.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await fs.mkdir(stateDir, { recursive: false, mode: 0o700 });
  }
}

async function readProjectCommandRegistry(registryPath) {
  try {
    const stat = await fs.lstat(registryPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > 512 * 1024) {
      throw new Error('Protected project-command registry is invalid.');
    }
    const parsed = JSON.parse(await fs.readFile(registryPath, 'utf8'));
    if (parsed?.version !== 1 || !Array.isArray(parsed.projects) || parsed.projects.length > 100) {
      throw new Error('Protected project-command registry is invalid.');
    }
    for (const project of parsed.projects) {
      if (!project || typeof project !== 'object' || !path.isAbsolute(String(project.root ?? '')) || !Array.isArray(project.commands) || project.commands.length > 100) {
        throw new Error('Protected project-command registry is invalid.');
      }
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, projects: [] };
    throw error;
  }
}

function sameWindowsPath(left, right) {
  return path.win32.resolve(String(left ?? '')).toLowerCase() === path.win32.resolve(String(right ?? '')).toLowerCase();
}

async function writeProjectCommandRegistry(registryPath, registry) {
  const text = JSON.stringify(registry, null, 2) + '\n';
  if (Buffer.byteLength(text, 'utf8') > 512 * 1024) throw new Error('Protected project-command registry exceeds its bounded size.');
  const temp = `${registryPath}.mecord-${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temp, registryPath);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

function randomSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function runChild(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, ...options });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`Process terminated by signal ${signal}.`));
      else resolve(code ?? 1);
    });
  });
}

function runRemoteChild(executable, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd, env, shell: false, windowsHide: false,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });
    let stopApprovals = null;
    let settled = false;
    const openedPairingUrls = new Set();
    const cleanup = () => { try { stopApprovals?.(); } catch { /* noop */ } stopApprovals = null; };
    child.on('message', (message) => {
      const ready = validateLocalAgentReadyMessage(message);
      if (ready && !stopApprovals) {
        stopApprovals = startLocalApprovalConsole({
          baseUrl: ready.baseUrl,
          agentToken: env.OPERATOR_AGENT_TOKEN,
          recoveryToken: env.OPERATOR_RECOVERY_TOKEN
        });
      }

      const pairing = validatePairingRequestMessage(message);
      if (!pairing || openedPairingUrls.has(pairing.url)) return;
      openedPairingUrls.add(pairing.url);
      if (openPairingPage(pairing.url, env)) {
        process.stdout.write('[mecord-connect] secure pairing page opened in your default browser.\n');
      } else {
        process.stdout.write(`[mecord-connect] open this secure pairing page: ${pairing.url}\n`);
      }
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true; cleanup(); reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true; cleanup();
      if (signal) reject(new Error(`Process terminated by signal ${signal}.`));
      else resolve(code ?? 1);
    });
  });
}
async function selfTestHelper(name) {
  const file = helperPath(name);
  const code = await runChild(file, ['--self-test'], {
    env: nativeEnvironment(),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  if (code !== 0) throw new Error(`${name} self-test failed with exit code ${code}.`);
}

async function healthCheckUia() {
  const file = helperPath('operator-windows-uia.exe');
  await new Promise((resolve, reject) => {
    const child = spawn(file, [], {
      shell: false,
      windowsHide: true,
      env: nativeEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let settled = false;
    let output = '';
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* noop */ }
      try { child.kill(); } catch { /* noop */ }
      if (error) reject(error); else resolve();
    };
    child.once('error', () => finish(new Error('Windows UIA helper could not start.')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output, 'utf8') > 64 * 1024) {
        finish(new Error('Windows UIA helper returned oversized health output.'));
        return;
      }
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(output.slice(0, newline));
        if (response?.id !== 'operator-doctor' || response?.ok !== true) throw new Error('unexpected response');
        finish();
      } catch {
        finish(new Error('Windows UIA helper health response was invalid.'));
      }
    });
    const timer = setTimeout(() => finish(new Error('Windows UIA helper health check timed out.')), 5000);
    timer.unref();
    child.stdin.end(`${JSON.stringify({ id: 'operator-doctor', method: 'health', params: {} })}\n`);
  });
}

export async function doctor() {
  assertSupportedRuntime();
  const manifest = await verifyRuntimePayload();
  await selfTestHelper('operator-windows-dpapi.exe');
  await selfTestHelper('operator-windows-path-lease.exe');
  await healthCheckUia();
  console.log('Mecord Connect doctor: PASS');
  console.log(`Package: ${PACKAGE_NAME}@${manifest.version}`);
  console.log(`Source: ${manifest.sourceCommit}`);
  console.log(`Runtime files: ${manifest.files.length}`);
  console.log(`Relay authority: ${RELAY_URL}`);
  return manifest;
}

export async function runRemote({ root = process.cwd(), browser = true } = {}) {
  assertSupportedRuntime();
  await verifyRuntimePayload();
  const authorizedRoot = await canonicalDirectory(root);
  const env = safeRuntimeEnvironment();
  env.OPERATOR_ALLOWED_ROOTS = authorizedRoot;
  env.OPERATOR_AGENT_HOST = '127.0.0.1';
  env.OPERATOR_AGENT_PORT = '0';
  env.OPERATOR_AGENT_TOKEN = randomSecret();
  env.OPERATOR_RECOVERY_TOKEN = randomSecret();
  env.OPERATOR_RELAY_URL = RELAY_URL;
  env.OPERATOR_RELAY_RESULT_URL = RELAY_RESULT_URL;
  env.OPERATOR_RELAY_REQUIRED = '1';
  env.OPERATOR_PAIR_URL_BASE = PAIR_URL_BASE;
  env.OPERATOR_BROWSER_AUTO_LAUNCH = browser ? '1' : '0';
  env.OPERATOR_WINDOWS_DPAPI_PATH = helperPath('operator-windows-dpapi.exe');
  env.OPERATOR_WINDOWS_UIA_PATH = helperPath('operator-windows-uia.exe');
  env.OPERATOR_WINDOWS_PATH_LEASE_PATH = helperPath('operator-windows-path-lease.exe');
  env.OPERATOR_REMOTE_PACKAGE = PACKAGE_NAME;

  console.log('[mecord-connect] starting secure remote runtime');
  console.log(`[mecord-connect] authorized root: ${authorizedRoot}`);
  console.log('[mecord-connect] ChatGPT uses the hosted MCP edge; no local MCP server is started.');
  console.log('[mecord-connect] paired devices reconnect automatically; first-time pairing opens the secure Mecord page when authorization is required.');

  const code = await runRemoteChild(process.execPath, [remoteEntrypoint], {
    cwd: authorizedRoot,
    env
  });
  if (code !== 0) throw new Error(`Mecord Connect remote runtime exited with code ${code}.`);
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.command === 'help') {
    console.log(usage());
    return;
  }
  if (args.command === 'doctor') {
    await doctor();
    return;
  }
  if (args.command === 'benchmark-register') {
    await registerBenchmark({ root: args.root, python: args.python, script: args.script });
    return;
  }
  await runRemote({ root: args.root, browser: args.browser });
}
