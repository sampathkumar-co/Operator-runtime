import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loopbackHttpStatus } from './http-probe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const shuttingDown = { value: false };

function provenance() {
  const sourceCommit = /^[0-9a-f]{40}$/i.test(process.env.OPERATOR_SOURCE_COMMIT ?? '')
    ? process.env.OPERATOR_SOURCE_COMMIT.toLowerCase()
    : 'unknown';
  const buildTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(process.env.OPERATOR_BUILD_TIMESTAMP ?? '')
    ? process.env.OPERATOR_BUILD_TIMESTAMP
    : 'unknown';
  return { sourceCommit, buildTimestamp };
}

function start(name, cwd, args, envOverrides = {}) {
  const child = spawn(process.execPath, args, {
    cwd: path.join(root, cwd),
    env: { ...process.env, ...envOverrides },
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

function requiredUrlHost(name) {
  const raw = process.env[name]?.trim();
  if (!raw) throw new Error(`${name} is required.`);
  return new URL(raw).host;
}

function developerEnabled() {
  const value = process.env.OPERATOR_MCP_DEVELOPER_ENABLED?.trim() || '0';
  if (!['0', '1'].includes(value)) throw new Error('OPERATOR_MCP_DEVELOPER_ENABLED must be 0 or 1.');
  return value === '1';
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
  const mcp = start('mcp-public', 'apps/mcp-server', ['--experimental-strip-types', 'src/server.ts'], {
    OPERATOR_MCP_PUBLIC_EDGE: '1',
    OPERATOR_MCP_DEVELOPER_EDGE: '0',
    OPERATOR_MCP_PORT: '47200'
  });
  children.push(mcp);
  await waitForHealth('http://127.0.0.1:47200/health', { headers: { host: requiredUrlHost('OPERATOR_MCP_PUBLIC_URL') } });

  let developer = false;
  if (developerEnabled()) {
    const developerUrl = process.env.OPERATOR_MCP_DEVELOPER_URL?.trim();
    if (!developerUrl) throw new Error('OPERATOR_MCP_DEVELOPER_URL is required when developer MCP is enabled.');
    const developerMcp = start('mcp-developer', 'apps/mcp-server', ['--experimental-strip-types', 'src/server.ts'], {
      OPERATOR_MCP_PUBLIC_EDGE: '0',
      OPERATOR_MCP_DEVELOPER_EDGE: '1',
      OPERATOR_MCP_PUBLIC_URL: developerUrl,
      OPERATOR_OAUTH_AUDIENCE: developerUrl,
      OPERATOR_MCP_PORT: '47201'
    });
    children.push(developerMcp);
    await waitForHealth('http://127.0.0.1:47201/health', { headers: { host: new URL(developerUrl).host } });
    developer = true;
  }
  process.stdout.write(JSON.stringify({ service: 'operator-public-edge', status: 'ready', developerMcp: developer, ...provenance() }) + '\n');

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
