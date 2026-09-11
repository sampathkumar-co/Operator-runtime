import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loopbackHttpStatus } from './http-probe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const shuttingDown = { value: false };

function start(name, cwd, args) {
  const child = spawn(process.execPath, args, {
    cwd: path.join(root, cwd),
    env: process.env,
    stdio: 'inherit',
    windowsHide: true
  });
  const exit = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ name, code, signal }));
  });
  child.once('error', (error) => {
    process.stderr.write(`[operator-edge] ${name} failed to start: ${error.message}\n`);
  });
  return { name, child, exit };
}

async function waitForHealth(url, options = {}) {
  const deadline = Date.now() + 30_000;
  let last = 'not ready';
  while (Date.now() < deadline) {
    try {
      const status = await loopbackHttpStatus(url, { headers: options.headers ?? {}, timeoutMs: 2_000 });
      if (status >= 200 && status < 300) return;
      last = `HTTP ${status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Health check timed out for ${url}: ${last}`);
}

function publicHostHeader() {
  const raw = process.env.OPERATOR_MCP_PUBLIC_URL?.trim();
  if (!raw) throw new Error('OPERATOR_MCP_PUBLIC_URL is required.');
  return new URL(raw).host;
}

async function terminate(children, signal) {
  if (shuttingDown.value) return;
  shuttingDown.value = true;
  for (const { child } of children) {
    if (!child.killed && child.exitCode === null) child.kill(signal);
  }
  await Promise.all(children.map(({ child }) => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 8_000);
    timer.unref();
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  })));
}

const relay = start('relay', 'apps/relay-server', ['--experimental-strip-types', 'src/main.ts']);
const children = [relay];
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void terminate(children, signal).finally(() => process.exit(process.exitCode ?? 0));
  });
}

try {
  await waitForHealth('http://127.0.0.1:8790/health');
  const mcp = start('mcp', 'apps/mcp-server', ['--experimental-strip-types', 'src/server.ts']);
  children.push(mcp);
  await waitForHealth('http://127.0.0.1:47200/health', { headers: { host: publicHostHeader() } });
  process.stdout.write(JSON.stringify({ service: 'operator-public-edge', status: 'ready' }) + '\n');

  const firstExit = await Promise.race(children.map(({ exit }) => exit));
  if (!shuttingDown.value) {
    process.stderr.write(`[operator-edge] ${firstExit.name} exited unexpectedly (code=${firstExit.code ?? 'null'}, signal=${firstExit.signal ?? 'null'}).\n`);
    process.exitCode = firstExit.code && firstExit.code > 0 ? firstExit.code : 1;
    await terminate(children, 'SIGTERM');
  }
} catch (error) {
  process.stderr.write(`[operator-edge] startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
  await terminate(children, 'SIGTERM');
}
