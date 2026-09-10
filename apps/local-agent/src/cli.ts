import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { safeChildEnvironment } from '../../../src/core/child-environment.ts';
import {
  BootstrapConfigStore,
  applyBootstrapEnvironment,
  defaultOperatorStateDir,
  windowsBootstrapProtector
} from './bootstrap-config.ts';

const args = process.argv.slice(2);
const command = args[0] ?? 'run';

try {
  if (command === 'setup') await setup(args.slice(1));
  else if (command === 'verify') await verify(args.slice(1));
  else if (command === 'run' && args.length === 1) await run();
  else if (command === '--help' || command === '-h' || command === 'help') printHelp();
  else if (args.length === 0) await run();
  else throw new OperatorError('CLI_ARGUMENT_INVALID', `Unknown Operator command: ${command}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[operator] ${message}`);
  process.exitCode = 1;
}

async function setup(rest: string[]): Promise<void> {
  const { root, startRuntime } = parseSetupArgs(rest);
  const stateDir = defaultOperatorStateDir();
  const store = new BootstrapConfigStore(stateDir, windowsBootstrapProtector());
  const config = await store.configure(root);
  applyBootstrapEnvironment(config);

  const identity = await new DeviceIdentityStore(stateDir).loadOrCreate();
  await verifyConfiguredState(stateDir, config);
  if (startRuntime) await ensureRuntimeReady(config);
  console.log('Operator setup: PASS');
  console.log(`Authorized root: ${config.allowedRoots[0]}`);
  console.log(`Device: ${identity.deviceName} (${identity.deviceId})`);
  console.log('Secrets: protected with Windows DPAPI CurrentUser');
  console.log('Verification: PASS');
  console.log(`Runtime: ${startRuntime ? 'running' : 'not started (--no-start)'}`);
  console.log(startRuntime ? 'Ready: connect Operator in ChatGPT.' : 'Ready: run operator when you want to start the runtime.');
}

async function verify(rest: string[]): Promise<void> {
  if (rest.length > 0) throw new OperatorError('CLI_ARGUMENT_INVALID', 'Operator verify does not accept arguments.');
  const stateDir = defaultOperatorStateDir();
  const store = new BootstrapConfigStore(stateDir, windowsBootstrapProtector());
  const config = await store.load();
  applyBootstrapEnvironment(config);

  await verifyConfiguredState(stateDir, config);

  console.log('Operator verify: PASS');
  console.log(`Authorized roots: ${config.allowedRoots.length}`);
  console.log(`Local agent: ${config.agentHost}:${config.agentPort}`);
  console.log(`Local MCP: ${config.mcpHost}:${config.mcpPort}/mcp`);
  console.log('Device identity: unlocked and signature verified');
  console.log('Secrets: DPAPI protected; no plaintext bootstrap secrets detected');
  console.log('Ready: run operator');
}

async function run(): Promise<void> {
  const stateDir = defaultOperatorStateDir();
  const store = new BootstrapConfigStore(stateDir, windowsBootstrapProtector());
  let config;
  try { config = await store.load(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new OperatorError('BOOTSTRAP_REQUIRED', 'Operator is not configured. Run "operator setup" once.');
    }
    throw error;
  }
  applyBootstrapEnvironment(config);
  await import('./main.ts');
  await import('../../mcp-server/src/server.ts');
}

function parseSetupArgs(rest: string[]): { root: string; startRuntime: boolean } {
  let root = process.env.OPERATOR_INVOKE_CWD ?? process.cwd();
  let startRuntime = true;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--no-start') { startRuntime = false; continue; }
    if (arg === '--root' && rest[index + 1]) { root = rest[index + 1]!; index += 1; continue; }
    throw new OperatorError('CLI_ARGUMENT_INVALID', 'Usage: operator setup [--root <authorized-folder>] [--no-start]');
  }
  return { root, startRuntime };
}

async function ensureRuntimeReady(config: Awaited<ReturnType<BootstrapConfigStore['load']>>): Promise<void> {
  if (await runtimeHealthy(config)) return;
  const dpapi = process.env.OPERATOR_WINDOWS_DPAPI_PATH;
  const uia = process.env.OPERATOR_WINDOWS_UIA_PATH;
  if (!dpapi || !path.isAbsolute(dpapi) || !uia || !path.isAbsolute(uia)) {
    throw new OperatorError('BOOTSTRAP_RUNTIME_START_FAILED', 'Packaged native helpers are required to start Operator automatically.');
  }
  const child = spawn(process.execPath, ['--experimental-strip-types', import.meta.filename, 'run'], {
    cwd: config.allowedRoots[0],
    detached: true,
    env: {
      ...safeChildEnvironment('desktop'),
      OPERATOR_STATE_DIR: config.stateDir,
      OPERATOR_WINDOWS_DPAPI_PATH: dpapi,
      OPERATOR_WINDOWS_UIA_PATH: uia
    },
    shell: false,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await runtimeHealthy(config)) return;
  }
  throw new OperatorError('BOOTSTRAP_RUNTIME_START_FAILED', 'Operator runtime did not become healthy after setup. Run "operator verify" for diagnostics.');
}

async function runtimeHealthy(config: Awaited<ReturnType<BootstrapConfigStore['load']>>): Promise<boolean> {
  const agentBase = `http://${formatHost(config.agentHost)}:${config.agentPort}`;
  const mcpBase = `http://${formatHost(config.mcpHost)}:${config.mcpPort}`;
  try {
    const agent = await readHealthJson(`${agentBase}/v1/settings`, {
      authorization: `Bearer ${config.agentToken}`
    });
    if (agent.status !== 200 || (agent.body as { ok?: unknown }).ok !== true) return false;
    const mcp = await readHealthJson(`${mcpBase}/health`);
    const body = mcp.body as { ok?: unknown; service?: unknown };
    return mcp.status === 200 && body.ok === true && body.service === 'operator-mcp-server';
  } catch {
    return false;
  }
}

async function readHealthJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  return await new Promise((resolve, reject) => {
    const req = http.get(url, {
      agent: false,
      headers: { ...headers, connection: 'close' }
    }, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 16 * 1024) {
          req.destroy(new Error('Operator readiness response exceeded 16 KiB.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(750, () => req.destroy(new Error('Operator readiness probe timed out.')));
    req.once('error', reject);
  });
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

async function verifyConfiguredState(stateDir: string, config: Awaited<ReturnType<BootstrapConfigStore['load']>>): Promise<void> {
  for (const root of config.allowedRoots) {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new OperatorError('BOOTSTRAP_ROOT_INVALID', `Authorized root is no longer a directory: ${root}`);
  }
  if (config.agentPort === config.mcpPort) {
    throw new OperatorError('BOOTSTRAP_CONFIG_INVALID', 'Local agent and MCP server ports must be distinct.');
  }
  await verifyDeviceIdentity(stateDir);
  await verifyMcpRuntime();
  await verifySecretsAreNotPlaintext(stateDir, config.agentToken, config.recoveryToken);
}

async function verifyDeviceIdentity(stateDir: string): Promise<void> {
  const store = new DeviceIdentityStore(stateDir);
  await store.loadOrCreate();
  const probe = Buffer.from('operator-one-command-verify-v1', 'utf8');
  const signature = await store.sign(probe);
  if (!(await store.verify(probe, signature))) {
    throw new OperatorError('DEVICE_IDENTITY_VERIFY_FAILED', 'Device identity signature round trip failed.');
  }
}

async function verifyMcpRuntime(): Promise<void> {
  const root = path.resolve(import.meta.dirname, '../../mcp-server');
  const required = [
    'src/server.ts',
    'src/local-agent-client.ts',
    'node_modules/fastify/package.json',
    'node_modules/zod/package.json',
    'node_modules/@modelcontextprotocol/server/package.json',
    'node_modules/@modelcontextprotocol/fastify/package.json'
  ];
  for (const relative of required) {
    try { await fs.access(path.join(root, relative)); }
    catch { throw new OperatorError('MCP_RUNTIME_MISSING', `Packaged MCP runtime is incomplete: ${relative}`); }
  }
}

async function verifySecretsAreNotPlaintext(stateDir: string, ...secrets: string[]): Promise<void> {
  const text = await fs.readFile(path.join(stateDir, 'bootstrap.json'), 'utf8');
  for (const secret of secrets) {
    if (text.includes(secret)) throw new OperatorError('BOOTSTRAP_SECRET_EXPOSED', 'Bootstrap configuration contains a plaintext secret.');
  }
}

function printHelp(): void {
  console.log([
    'Operator',
    '',
    '  operator setup [--root <folder>]      Configure, verify, and start Operator once.',
    '  operator verify                       Re-run protected config/runtime verification.',
    '  operator                              Start the local agent and MCP server.',
    '',
    'Setup never prints or stores plaintext bearer/recovery secrets.'
  ].join('\n'));
}
