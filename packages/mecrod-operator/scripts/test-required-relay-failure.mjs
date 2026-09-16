import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(packageRoot, 'runtime');
const main = path.join(runtimeRoot, 'app', 'apps', 'local-agent', 'src', 'main.ts');
const native = path.join(runtimeRoot, 'native');

await runCase('persisted emergency stop', async (stateDir) => {
  await fs.writeFile(path.join(stateDir, 'emergency-stop.json'), JSON.stringify({
    version: 1,
    engaged: true,
    engagedAt: new Date().toISOString(),
    reason: 'npm required-relay certification'
  }), 'utf8');
}, /required relay failed:.*emergency stop/i);

await runCase('terminal relay state failure', async (stateDir) => {
  await fs.writeFile(path.join(stateDir, 'relay-client.json'), '{not-json', 'utf8');
}, /required relay failed:.*state/i);

console.log('operator-required-relay-failure:ok');

async function runCase(name, setup, expectedError) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-required-relay-'));
  const stateDir = path.join(base, 'state');
  const allowedRoot = path.join(base, 'root');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(allowedRoot, { recursive: true });
  try {
    await setup(stateDir);
    const result = await runAgent(stateDir, allowedRoot);
    if (result.code === 0) throw new Error(`${name}: relay-only local agent exited successfully instead of failing closed.`);
    if (result.signal) throw new Error(`${name}: relay-only local agent terminated by ${result.signal}.`);
    if (!expectedError.test(result.stderr)) {
      throw new Error(`${name}: expected fail-closed diagnostic was missing. stderr=${JSON.stringify(result.stderr)}`);
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

function runAgent(stateDir, allowedRoot) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      OPERATOR_ALLOWED_ROOTS: allowedRoot,
      OPERATOR_AGENT_HOST: '127.0.0.1',
      OPERATOR_AGENT_PORT: '0',
      OPERATOR_AGENT_TOKEN: crypto.randomBytes(32).toString('base64url'),
      OPERATOR_RECOVERY_TOKEN: crypto.randomBytes(32).toString('base64url'),
      OPERATOR_STATE_DIR: stateDir,
      OPERATOR_BROWSER_AUTO_LAUNCH: '0',
      OPERATOR_RELAY_URL: 'ws://127.0.0.1:1/device',
      OPERATOR_RELAY_RESULT_URL: 'http://127.0.0.1:1/v1/device-result',
      OPERATOR_RELAY_ALLOW_INSECURE_LOOPBACK: '1',
      OPERATOR_RELAY_REQUIRED: '1',
      OPERATOR_WINDOWS_DPAPI_PATH: path.join(native, 'operator-windows-dpapi.exe'),
      OPERATOR_WINDOWS_UIA_PATH: path.join(native, 'operator-windows-uia.exe'),
      OPERATOR_WINDOWS_PATH_LEASE_PATH: path.join(native, 'operator-windows-path-lease.exe')
    };
    const child = spawn(process.execPath, ['--experimental-strip-types', main], {
      env, cwd: allowedRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const append = (current, chunk) => (current + chunk.toString('utf8')).slice(-64 * 1024);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      reject(new Error('required relay fail-closed test timed out.'));
    }, 10_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}
