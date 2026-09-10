import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../../../src/core/audit.ts';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { DeviceRegistryStore } from '../../../src/core/device-registry.ts';
import { TaskStore } from '../../../src/core/task-store.ts';
import { createRuntime } from './runtime-factory.ts';
import { createLocalAgentServer } from './server.ts';
import { EmergencyStopStore } from './emergency-stop.ts';
import { LocalPrivacyDataStore } from './privacy-data.ts';
import { LocalAgentRelayRunner } from './relay-agent.ts';

const allowedRoots = (process.env.OPERATOR_ALLOWED_ROOTS ?? process.cwd())
  .split(path.delimiter)
  .filter(Boolean)
  .map((root) => path.resolve(root));

// This allowlist is used only by commands explicitly declared in the trusted
// Operator project-command registry outside project roots. Generic terminal
// execution has a separate, empty-by-default allowlist below.
const allowedExecutables = (process.env.OPERATOR_ALLOWED_EXECUTABLES ?? 'git,node,npm,npx,pnpm,python,python3')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const terminalAllowedExecutables = (process.env.OPERATOR_TERMINAL_ALLOWED_EXECUTABLES ?? '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const token = process.env.OPERATOR_AGENT_TOKEN;
if (!token || token.length < 32) {
  console.error('[operator] OPERATOR_AGENT_TOKEN must be set to a secret of at least 32 characters.');
  process.exit(2);
}

const recoveryToken = process.env.OPERATOR_RECOVERY_TOKEN;
if (recoveryToken !== undefined && recoveryToken.length < 32) {
  console.error('[operator] OPERATOR_RECOVERY_TOKEN must be at least 32 characters when set.');
  process.exit(2);
}

const stateDir = path.resolve(process.env.OPERATOR_STATE_DIR ?? path.join(os.homedir(), '.operator'));
const emergencyStop = new EmergencyStopStore(stateDir);
const audit = new AuditLog(stateDir);
const tasks = new TaskStore(stateDir);
const deviceIdentity = new DeviceIdentityStore(stateDir);
const deviceRegistry = new DeviceRegistryStore(stateDir);
const privacy = new LocalPrivacyDataStore(stateDir);
const browserAutoLaunch = process.env.OPERATOR_BROWSER_AUTO_LAUNCH !== '0';
const relayUrl = process.env.OPERATOR_RELAY_URL?.trim();
const relayResultUrl = process.env.OPERATOR_RELAY_RESULT_URL?.trim();
const relayTokenFile = path.resolve(process.env.OPERATOR_RELAY_SESSION_TOKEN_FILE?.trim() || path.join(stateDir, 'relay-session.token'));
const relayAllowInsecureLoopback = process.env.OPERATOR_RELAY_ALLOW_INSECURE_LOOPBACK === '1';

const runtime = createRuntime({
  allowedRoots,
  allowedExecutables,
  terminalAllowedExecutables,
  projectCommandRegistryPath: process.env.OPERATOR_PROJECT_COMMAND_REGISTRY,
  dockerExecutable: process.env.OPERATOR_DOCKER_PATH,
  postgresProfileRegistryPath: process.env.OPERATOR_POSTGRES_PROFILE_REGISTRY,
  psqlExecutable: process.env.OPERATOR_PSQL_PATH,
  vscodeExecutable: process.env.OPERATOR_VSCODE_PATH,
  vscodeDataDir: process.env.OPERATOR_VSCODE_DATA_DIR,
  cdpEndpoint: process.env.OPERATOR_CDP_ENDPOINT,
  browserAutoLaunch,
  browserPath: process.env.OPERATOR_BROWSER_PATH,
  browserDataDir: process.env.OPERATOR_BROWSER_DATA_DIR,
  windowsUiaPath: process.env.OPERATOR_WINDOWS_UIA_PATH
});

let relayRunner: LocalAgentRelayRunner | null = null;
let relayRun: Promise<void> | null = null;
let localAgentBaseUrl = '';
let shuttingDown = false;

function stopRelay(): void {
  relayRunner?.stop();
}

function startRelay(): void {
  if (!relayUrl || shuttingDown || relayRun) return;
  relayRunner = new LocalAgentRelayRunner({
    stateDir,
    relayUrl,
    resultUrl: relayResultUrl,
    sessionTokenFile: relayTokenFile,
    identity: deviceIdentity,
    localAgentBaseUrl,
    agentToken: token,
    allowLoopbackInsecure: relayAllowInsecureLoopback
  });
  const runner = relayRunner;
  relayRun = runner.run()
    .catch((error) => {
      console.error(`[operator] relay connection stopped: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      if (relayRunner === runner) relayRunner = null;
      relayRun = null;
    });
}

const agent = createLocalAgentServer({
  runtime,
  token,
  recoveryToken,
  emergencyStop,
  audit,
  tasks,
  deviceIdentity,
  deviceRegistry,
  privacy,
  onEmergencyStop: () => stopRelay(),
  onEmergencyClear: () => {
    try { startRelay(); }
    catch (error) { console.error(`[operator] relay reconnect after emergency recovery failed: ${error instanceof Error ? error.message : String(error)}`); }
  },
  settings: {
    recoveryConfigured: Boolean(recoveryToken),
    browserAutoLaunch,
    cdpEndpointConfigured: Boolean(process.env.OPERATOR_CDP_ENDPOINT),
    browserPathConfigured: Boolean(process.env.OPERATOR_BROWSER_PATH),
    projectCommandRegistryConfigured: Boolean(process.env.OPERATOR_PROJECT_COMMAND_REGISTRY),
    dockerConfigured: Boolean(process.env.OPERATOR_DOCKER_PATH),
    postgresConfigured: Boolean(process.env.OPERATOR_POSTGRES_PROFILE_REGISTRY),
    vscodeConfigured: Boolean(process.env.OPERATOR_VSCODE_PATH),
    windowsUiaConfigured: Boolean(process.env.OPERATOR_WINDOWS_UIA_PATH),
    relayConfigured: Boolean(relayUrl),
    relayResultConfigured: Boolean(relayResultUrl),
    relayTokenFileConfigured: Boolean(relayUrl),
    authorizedRootCount: allowedRoots.length,
    projectExecutableAllowlistCount: allowedExecutables.length,
    terminalExecutableAllowlistCount: terminalAllowedExecutables.length
  },
  permissions: {
    allowedCapabilities: ['computer.inspect', 'project.inspect', 'project.command.*', 'project.transaction.*', 'docker.*', 'postgres.*', 'vscode.*', 'file.*', 'git.*', 'terminal.execute', 'browser.inspect', 'browser.navigate', 'browser.interact', 'app.inspect', 'app.operate'],
    allowedRoots,
    allowExternalWrites: false,
    allowSystemChanges: false,
    allowDestructive: false
  }
});

const host = process.env.OPERATOR_AGENT_HOST ?? '127.0.0.1';
const port = Number(process.env.OPERATOR_AGENT_PORT ?? 47100);
const bound = await agent.listen(host, port);
localAgentBaseUrl = relayUrl ? `http://${loopbackAddressForBoundHost(bound.host)}:${bound.port}` : '';
console.error(`[operator] local agent listening on http://${bound.host}:${bound.port}`);
console.error(`[operator] authorized roots: ${allowedRoots.join(', ')}`);
console.error(`[operator] protected state directory: ${stateDir}`);
console.error(`[operator] recovery API: ${recoveryToken ? 'configured' : 'disabled until OPERATOR_RECOVERY_TOKEN is set'}`);
console.error(`[operator] generic terminal: ${terminalAllowedExecutables.length ? 'explicit allowlist configured' : 'disabled by default'}`);
console.error(`[operator] relay: ${relayUrl ? 'configured' : 'disabled'}`);

if (relayUrl && !(await emergencyStop.status()).engaged) {
  try { startRelay(); }
  catch (error) { console.error(`[operator] relay startup failed: ${error instanceof Error ? error.message : String(error)}`); }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopRelay();
    await Promise.allSettled([relayRun, agent.close(), runtime.close()].filter(Boolean) as Array<Promise<unknown>>);
    process.exit(0);
  });
}

function loopbackAddressForBoundHost(hostInput: string): string {
  const host = hostInput.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '::1' || host === '::') return '[::1]';
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === 'localhost' || host === '127.0.0.1') return host;
  throw new Error('Relay integration requires the local agent to bind to loopback or a wildcard interface so it can re-enter through the local policy boundary.');
}
