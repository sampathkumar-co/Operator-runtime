import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../../../src/core/audit.ts';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { DeviceRegistryStore } from '../../../src/core/device-registry.ts';
import { TaskStore } from '../../../src/core/task-store.ts';
import { createRuntime } from './runtime-factory.ts';
import { createLocalAgentServer } from './server.ts';
import { EmergencyStopStore } from './emergency-stop.ts';
import { ApprovalStore } from './approval-store.ts';
import { LocalActionExecutionStore } from './action-execution-store.ts';
import { SessionApprovalStore } from './session-approval.ts';
import { LocalPrivacyDataStore } from './privacy-data.ts';
import { LocalAgentRelayRunner } from './relay-agent.ts';
import { windowsBootstrapProtector } from './bootstrap-config.ts';
import { RelaySessionCredentialManager, deriveRelayDeviceResetUrl, deriveRelaySessionRotateUrl } from './relay-session-credentials.ts';
import { LocalDeviceResetCoordinator } from './device-reset.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { RelayEnrollmentClient } from './relay-enrollment.ts';
import { DEVELOPER_RELAY_CAPABILITIES } from '../../../src/core/developer-relay-surface.ts';
import { TaskOrchestrator } from '../../../src/core/task-orchestrator.ts';
import { TeamCoordinator } from '../../../src/core/team-coordinator.ts';
import { ProcedureMemoryStore } from '../../../src/core/procedure-memory.ts';
import { WorldModelStore } from '../../../src/core/world-model.ts';
import { DeviceRoutingStore } from '../../../src/core/device-routing.ts';
import { DevicePoolScheduler } from '../../../src/core/device-pool.ts';
import { ExecutionOptimizerStore } from '../../../src/core/execution-optimizer.ts';
import { OrganizationCoordinator } from '../../../src/core/organization-coordinator.ts';
import { DigitalOperationsLayer } from '../../../src/core/digital-operations.ts';
import { evidence } from '../../../src/core/evidence.ts';
import { ResourceLeaseStore } from '../../../src/core/resource-leases.ts';
import { TeachModeStore } from '../../../src/core/studio-teach.ts';
import { DesiredStateController } from '../../../src/core/desired-state.ts';
import { DesiredStateReconciler } from '../../../src/core/desired-state-reconciler.ts';
import { DurableEventRuntime } from '../../../src/core/event-runtime.ts';
import { DurableEventTicker } from '../../../src/core/event-ticker.ts';
import { PerceptionGraphStore } from '../../../src/core/perception-graph.ts';
import { publishPerceptionFromActionResult } from '../../../src/core/perception-publication.ts';
import { StudioWorkflowExecutor } from '../../../src/core/studio-executor.ts';
import { SemanticCheckpointManager } from '../../../src/core/semantic-checkpoint.ts';
import { EnterprisePolicyStore } from '../../../src/core/enterprise-policy.ts';
import { acquireLocalAgentStateInstanceLock } from './state-instance-lock.ts';
import { AgentKernel } from '../../../src/core/agent-kernel.ts';
import { ActionTransitionJournal } from '../../../src/core/action-transition-journal.ts';
import { IntentRegistry } from '../../../src/core/intent-registry.ts';
import { DurableSagaKernel } from '../../../src/core/durable-saga.ts';
import { BoundedTaskIntelligence } from '../../../src/core/task-intelligence.ts';

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
const stateInstanceLock = await acquireLocalAgentStateInstanceLock(stateDir);
const remoteLauncherIpc = process.env.OPERATOR_REMOTE_PACKAGE === 'mecord-connect' && typeof process.send === 'function';
let launcherShutdownRequested = false;
let launcherShutdownReason = 'launcher-disconnected';
let launcherShutdownHandler: (() => void) | null = null;
if (remoteLauncherIpc) {
  process.once('disconnect', () => {
    launcherShutdownRequested = true;
    launcherShutdownReason = 'launcher-disconnected';
    launcherShutdownHandler?.();
  });
  process.on('message', (message) => {
    const signal = launcherShutdownSignal(message);
    if (!signal) return;
    launcherShutdownRequested = true;
    launcherShutdownReason = `launcher-${signal.toLowerCase()}`;
    launcherShutdownHandler?.();
  });
}
const permissions = {
  allowedCapabilities: ['computer.inspect', 'project.inspect', 'project.command.*', 'project.transaction.*', 'docker.*', 'compute.run', 'postgres.*', 'vscode.*', 'file.*', 'git.*', 'terminal.execute', 'terminal.session', 'process.inspect', 'process.manage', 'browser.inspect', 'browser.verify', 'browser.navigate', 'browser.interact', 'browser.tab.focus', 'browser.tab.close', 'app.inspect', 'app.operate', 'visual.capture', 'input.operate', 'perception.*'],
  allowedRoots,
  allowExternalWrites: false,
  allowSystemChanges: false,
  allowDestructive: false
};
const emergencyStop = new EmergencyStopStore(stateDir);
const approvals = new ApprovalStore(stateDir);
const actionExecutions = new LocalActionExecutionStore(stateDir);
const sessionApprovals = new SessionApprovalStore();
const audit = new AuditLog(stateDir);
const tasks = new TaskStore(stateDir);
const resourceLeases = new ResourceLeaseStore(stateDir);
const actionJournal = new ActionTransitionJournal(stateDir);
const intentRegistry = new IntentRegistry(stateDir);
const procedures = new ProcedureMemoryStore(stateDir);
const world = new WorldModelStore(stateDir);
const perception = new PerceptionGraphStore(stateDir);
const optimizer = new ExecutionOptimizerStore(stateDir);
const taskIntelligence = new BoundedTaskIntelligence({ world, procedures, perception, optimizer });
const deviceIdentity = new DeviceIdentityStore(stateDir);
const deviceRegistry = new DeviceRegistryStore(stateDir);
const semanticMigration = new SemanticCheckpointManager(stateDir, {
  identity: deviceIdentity,
  registry: deviceRegistry
});
const deviceRouting = new DeviceRoutingStore(stateDir, deviceRegistry);
const devicePool = new DevicePoolScheduler(stateDir, deviceRegistry, deviceRouting);
const enterprisePolicy = new EnterprisePolicyStore(stateDir);
const events = new DurableEventRuntime(stateDir);
const privacy = new LocalPrivacyDataStore(stateDir);
const browserAutoLaunch = process.env.OPERATOR_BROWSER_AUTO_LAUNCH !== '0';
const relayUrl = process.env.OPERATOR_RELAY_URL?.trim();
const relayResultUrl = process.env.OPERATOR_RELAY_RESULT_URL?.trim();
const relayTokenFile = path.resolve(process.env.OPERATOR_RELAY_SESSION_TOKEN_FILE?.trim() || path.join(stateDir, 'relay-session.token'));
const relayAllowInsecureLoopback = process.env.OPERATOR_RELAY_ALLOW_INSECURE_LOOPBACK === '1';
const relayRequired = process.env.OPERATOR_RELAY_REQUIRED === '1';
const pairUrlBase = process.env.OPERATOR_PAIR_URL_BASE?.trim();
let pairUrl: URL | undefined;
if (pairUrlBase) {
  pairUrl = new URL(pairUrlBase);
  if (pairUrl.protocol !== 'https:' || pairUrl.username || pairUrl.password || pairUrl.hash || pairUrl.search || pairUrl.pathname !== '/pair') {
    throw new OperatorError('PAIR_URL_INVALID', 'Device pairing URL must be credential-free HTTPS ending exactly at /pair.');
  }
}
if (relayRequired && !relayUrl) {
  throw new OperatorError('RELAY_REQUIRED_CONFIGURATION_MISSING', 'Relay-only mode requires an explicit relay URL.');
}

const runtime = createRuntime({
  stateDir,
  allowedRoots,
  allowedExecutables,
  terminalAllowedExecutables,
  projectCommandRegistryPath: process.env.OPERATOR_PROJECT_COMMAND_REGISTRY,
  dockerExecutable: process.env.OPERATOR_DOCKER_PATH,
  computeJavascriptImage: process.env.OPERATOR_COMPUTE_JS_IMAGE,
  computePythonImage: process.env.OPERATOR_COMPUTE_PY_IMAGE,
  postgresProfileRegistryPath: process.env.OPERATOR_POSTGRES_PROFILE_REGISTRY,
  psqlExecutable: process.env.OPERATOR_PSQL_PATH,
  vscodeExecutable: process.env.OPERATOR_VSCODE_PATH,
  vscodeDataDir: process.env.OPERATOR_VSCODE_DATA_DIR,
  cdpEndpoint: process.env.OPERATOR_CDP_ENDPOINT,
  browserAutoLaunch,
  browserPath: process.env.OPERATOR_BROWSER_PATH,
  browserDataDir: process.env.OPERATOR_BROWSER_DATA_DIR,
  windowsUiaPath: process.env.OPERATOR_WINDOWS_UIA_PATH,
  windowsPathLeasePath: process.env.OPERATOR_WINDOWS_PATH_LEASE_PATH,
  perception
});
const agentKernel = new AgentKernel({
  stateDir,
  runtime,
  leases: resourceLeases,
  journal: actionJournal,
  intents: intentRegistry,
  observeResult: async (action, result) => {
    try {
      await publishPerceptionFromActionResult(perception, action, result);
    } catch (error) {
      await audit.append({
        ...(action.taskId ? { traceId: action.taskId, taskId: action.taskId } : {}),
        actionId: action.id,
        providerId: 'perception.graph',
        capability: 'perception.publish',
        result: 'failure',
        risk: 'write',
        details: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'PERCEPTION_PUBLICATION_FAILED' }
      });
      throw error;
    }
  }
});
const teams = new TeamCoordinator(stateDir, {
  requireKernelVerification: true,
  intentRegistry,
  actionJournal,
  agentKernel,
  permissions
});
const organizations = new OrganizationCoordinator(stateDir, teams);
const organizationRecovery = await organizations.recoverPendingCompensations();
if (organizationRecovery.pending > 0) {
  console.warn(`[operator] ${organizationRecovery.pending} organization compensation intent(s) still require recovery before affected rollouts can advance.`);
}
const teachMode = new TeachModeStore(stateDir, {
  journal: actionJournal,
  requireKernelVerification: true,
  intentRegistry,
  agentKernel,
  permissions
});
const sagas = new DurableSagaKernel(stateDir, { kernel: agentKernel, permissions });
const studioExecutor = new StudioWorkflowExecutor(stateDir, {
  teach: teachMode,
  runtime,
  leases: resourceLeases,
  permissions,
  agentKernel,
  intentRegistry
});
const recoveredStudioRuns = await studioExecutor.recoverInterrupted();
const operationCapabilities = await runtime.supportedCapabilities(permissions.allowedCapabilities);
const operations = new DigitalOperationsLayer(stateDir, {
  procedures,
  world,
  devices: devicePool,
  optimizer,
  teams,
  organizations,
  availableCapabilities: operationCapabilities
});
const desiredState = new DesiredStateController(stateDir, { world, operations });
const desiredStateIntervalMs = Number(process.env.OPERATOR_DESIRED_STATE_INTERVAL_MS ?? 60_000);
if (!Number.isSafeInteger(desiredStateIntervalMs) || desiredStateIntervalMs < 1_000 || desiredStateIntervalMs > 24 * 60 * 60_000) {
  throw new OperatorError('DESIRED_STATE_INTERVAL_INVALID', 'OPERATOR_DESIRED_STATE_INTERVAL_MS must be an integer from 1000 to 86400000.');
}
const desiredStateReconciler = new DesiredStateReconciler(desiredState, {
  intervalMs: desiredStateIntervalMs,
  onError: (error) => console.error(`[operator] desired-state reconcile tick failed: ${error instanceof Error ? error.message : String(error)}`)
});
const eventTickIntervalMs = Number(process.env.OPERATOR_EVENT_TICK_INTERVAL_MS ?? 1_000);
if (!Number.isSafeInteger(eventTickIntervalMs) || eventTickIntervalMs < 250 || eventTickIntervalMs > 60_000) {
  throw new OperatorError('EVENT_TICK_INTERVAL_INVALID', 'OPERATOR_EVENT_TICK_INTERVAL_MS must be an integer from 250 to 60000.');
}
const eventTicker = new DurableEventTicker(events, {
  intervalMs: eventTickIntervalMs,
  onError: (error) => console.error(`[operator] event tick failed: ${error instanceof Error ? error.message : String(error)}`)
});
let relayRunner: LocalAgentRelayRunner | null = null;
let relayRun: Promise<void> | null = null;
let relaySessionCredentials: RelaySessionCredentialManager | null = null;
let localAgentBaseUrl = '';
let relayConnectionStatus: Record<string, unknown> = {
  state: relayUrl ? 'STARTING' : 'DISABLED',
  updatedAt: new Date().toISOString()
};
let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;

function stopRelay(): void {
  relayRunner?.stop();
  relaySessionCredentials?.stop();
}

async function shutdownRuntime(exitCode: number, reason: string): Promise<void> {
  if (shutdownPromise) return await shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    console.error(`[operator] shutting down (${reason})`);
    stopRelay();
    const pendingRelay = relayRun;
    await Promise.allSettled([
      pendingRelay,
      desiredStateReconciler.stop(),
      eventTicker.stop(),
      agent.close(),
      runtime.close()
    ].filter(Boolean) as Array<Promise<unknown>>);
    await stateInstanceLock.release();
    process.exitCode = exitCode;
  })();
  return await shutdownPromise;
}

async function failRequiredRelay(error: unknown): Promise<void> {
  if (!relayRequired || shuttingDown) return;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[operator] required relay failed: ${message}`);
  await shutdownRuntime(1, 'required-relay-failure');
  setImmediate(() => process.exit(1));
}

function startRelay(): void {
  if (!relayUrl || shuttingDown || relayRun) return;
  const enrollment = new RelayEnrollmentClient({
    relayUrl, resultUrl: relayResultUrl, identity: deviceIdentity,
    allowLoopbackInsecure: relayAllowInsecureLoopback,
    onUserCode: ({ userCode, expiresAt }) => {
      console.error(`[operator] device pairing code: ${userCode} (expires ${expiresAt})`);
      if (pairUrl) {
        const url = new URL(pairUrl);
        url.searchParams.set('code', userCode);
        console.error(`[operator] pair this device: ${url.toString()}`);
        if (remoteLauncherIpc) sendLauncherMessage({ type: 'mecord-pairing-required', url: url.toString(), expiresAt });
      }
    }
  });
  const sessionCredentials = new RelaySessionCredentialManager({
    stateDir,
    legacyTokenFile: relayTokenFile,
    rotateUrl: deriveRelaySessionRotateUrl(relayUrl, relayResultUrl, relayAllowInsecureLoopback),
    protector: windowsBootstrapProtector(),
    allowLoopbackInsecure: relayAllowInsecureLoopback,
    enrollment,
    onCredentialRotated: () => relayRunner?.reconnect(),
    onBackgroundRefreshFailure: ({ code, retryable }) => {
      relayConnectionStatus = {
        state: 'DEGRADED',
        code,
        recoverable: retryable,
        credentialRefreshPending: true,
        updatedAt: new Date().toISOString()
      };
      console.error(`[operator] relay credential refresh pending (${code}); keeping the current transport alive while recovery continues`);
    }
  });
  relaySessionCredentials = sessionCredentials;
  relayRunner = new LocalAgentRelayRunner({
    stateDir,
    relayUrl,
    resultUrl: relayResultUrl,
    sessionTokenFile: relayTokenFile,
    sessionCredentials,
    identity: deviceIdentity,
    localAgentBaseUrl,
    agentToken: token,
    getSupportedCapabilities: () => runtime.supportedCapabilities(DEVELOPER_RELAY_CAPABILITIES),
    onConnectionState: (status) => {
      relayConnectionStatus = { ...status, updatedAt: new Date().toISOString() };
      if (status.state === 'STARTING') console.error('[operator] relay starting');
      else if (status.state === 'CONNECTING') console.error(status.attempt === 1 ? '[operator] connecting to relay' : `[operator] recovering relay connection (attempt ${status.attempt})`);
      else if (status.state === 'AUTHENTICATING') console.error('[operator] relay connected; authenticating');
      else if (status.state === 'READY') console.error(`[operator] Mecord ready (${status.capabilityCount} capabilities)`);
      else if (status.state === 'RECONNECTING') console.error(`[operator] recovering connection (${status.code}, retry in ${status.delayMs}ms)`);
      else if (status.state === 'DEGRADED') console.error(`[operator] relay degraded (${status.code})${status.recoverable ? '; recovery is automatic' : ''}`);
      else if (status.state === 'REVOKED') console.error(`[operator] relay authority revoked (${status.code})`);
      else if (status.state === 'SHUTTING_DOWN') console.error('[operator] relay shutting down');
    },
    allowLoopbackInsecure: relayAllowInsecureLoopback
  });
  const runner = relayRunner;
  relayRun = runner.run()
    .then(async () => {
      if (relayRequired && !shuttingDown) {
        await failRequiredRelay(new OperatorError('RELAY_REQUIRED_STOPPED', 'The required relay connection stopped.'));
      }
    })
    .catch(async (error) => {
      console.error(`[operator] relay connection stopped: ${error instanceof Error ? error.message : String(error)}`);
      await failRequiredRelay(error);
    })
    .finally(() => {
      runner.stop();
      if (relayRunner === runner) relayRunner = null;
      if (relaySessionCredentials === sessionCredentials) relaySessionCredentials = null;
      relayRun = null;
    });
}

async function resetLocalDevice() {
  const coordinator = new LocalDeviceResetCoordinator({
    stateDir,
    identity: deviceIdentity,
    resetUrl: relayUrl ? deriveRelayDeviceResetUrl(relayUrl, relayResultUrl, relayAllowInsecureLoopback) : undefined,
    getResetToken: relayUrl ? async () => {
      const credentials = relaySessionCredentials;
      if (!credentials) throw new OperatorError('DEVICE_RESET_RELAY_UNAVAILABLE', 'Relay session credentials are not active; start Operator and retry device reset.');
      return await credentials.forReset();
    } : undefined,
    stopRelay: async () => {
      stopRelay();
      const activeRun = relayRun;
      if (activeRun) await activeRun;
    }
  });
  return await coordinator.reset();
}

const taskOrchestrator = new TaskOrchestrator({
  runtime,
  store: tasks,
  permissions,
  intentRegistry,
  actionJournal,
  intelligence: taskIntelligence,
  executeAction: async (action, actionPermissions, context) => {
    if ((await emergencyStop.status()).engaged) {
      return {
        ok: false,
        capability: action.capability,
        provider: 'policy',
        evidence: [evidence('emergency_stop', 'fail', 'Operator execution is disabled by the local emergency stop.')],
        error: { code: 'EMERGENCY_STOPPED', message: 'Operator execution is disabled by the local emergency stop.', retryable: false },
        durationMs: 0
      };
    }
    const result = await agentKernel.execute(action, actionPermissions, {
      ...context,
      ownerKind: 'task',
      ownerId: action.taskId ?? action.id
    });
    await audit.append({
      ...(action.taskId ? { traceId: action.taskId, taskId: action.taskId } : {}),
      actionId: action.id,
      providerId: result.provider,
      capability: action.capability,
      target: action.target,
      result: result.ok ? 'success' : result.provider === 'policy' ? 'blocked' : 'failure',
      risk: action.risk,
      details: {
        durationMs: result.durationMs,
        errorCode: result.error?.code,
        sideEffectState: result.error?.sideEffectState
      }
    });
    return result;
  }
});

const agent = createLocalAgentServer({
  runtime,
  agentKernel,
  intentRegistry,
  sagas,
  token,
  recoveryToken,
  emergencyStop,
  approvals,
  actionExecutions,
  sessionApprovals,
  audit,
  tasks,
  taskOrchestrator,
  teams,
  procedures,
  world,
  devicePool,
  optimizer,
  organizations,
  operations,
  events,
  perception,
  teachMode,
  studioExecutor,
  semanticMigration,
  enterprisePolicy,
  desiredState,
  deviceIdentity,
  deviceRegistry,
  privacy,
  deviceReset: resetLocalDevice,
  onEmergencyStop: () => stopRelay(),
  onEmergencyClear: () => {
    try { startRelay(); }
    catch (error) { console.error(`[operator] relay reconnect after emergency recovery failed: ${error instanceof Error ? error.message : String(error)}`); }
  },
  getRuntimeStatus: () => ({
    relay: {
      ...relayConnectionStatus,
      configured: Boolean(relayUrl),
      required: relayRequired,
      continuity: relayUrl ? 'automatic' : 'disabled'
    }
  }),
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
    studioWorkflowExecutorConfigured: true,
    semanticMigrationConfigured: true,
    enterprisePolicyConfigured: await enterprisePolicy.isConfigured(),
    recoveredStudioRunCount: recoveredStudioRuns,
    desiredStateReconcilerConfigured: true,
    desiredStateIntervalMs,
    eventRuntimeConfigured: true,
    eventTickIntervalMs,
    relayConfigured: Boolean(relayUrl),
    relayResultConfigured: Boolean(relayResultUrl),
    relayTokenFileConfigured: Boolean(relayUrl),
    authorizedRootCount: allowedRoots.length,
    projectExecutableAllowlistCount: allowedExecutables.length,
    terminalExecutableAllowlistCount: terminalAllowedExecutables.length
  },
  permissions
});

const host = process.env.OPERATOR_AGENT_HOST ?? '127.0.0.1';
const port = Number(process.env.OPERATOR_AGENT_PORT ?? 47100);
const bound = await agent.listen(host, port);
localAgentBaseUrl = relayUrl ? `http://${loopbackAddressForBoundHost(bound.host)}:${bound.port}` : '';
if (remoteLauncherIpc) {
  launcherShutdownHandler = () => {
    void shutdownRuntime(0, launcherShutdownReason).finally(() => process.exit(0));
  };
  if (launcherShutdownRequested) {
    await shutdownRuntime(0, launcherShutdownReason);
    process.exit(0);
  }
}
console.error(`[operator] local agent listening on http://${bound.host}:${bound.port}`);
if (remoteLauncherIpc) sendLauncherMessage({ type: 'mecord-local-agent-ready', host: bound.host, port: bound.port });
console.error(`[operator] authorized roots: ${allowedRoots.join(', ')}`);
console.error(`[operator] protected state directory: ${stateDir}`);
console.error(`[operator] recovery API: ${recoveryToken ? 'configured' : 'disabled until OPERATOR_RECOVERY_TOKEN is set'}`);
console.error(`[operator] generic terminal: ${terminalAllowedExecutables.length ? 'explicit allowlist configured' : 'disabled by default'}`);
console.error(`[operator] relay: ${relayUrl ? 'configured' : 'disabled'}`);
console.error(`[operator] studio workflow recovery: ${recoveredStudioRuns} interrupted run(s) reconciled`);
console.error(`[operator] desired-state reconciler: every ${desiredStateIntervalMs}ms`);
console.error(`[operator] durable event ticker: every ${eventTickIntervalMs}ms`);
desiredStateReconciler.start();
eventTicker.start();
if (relayUrl) {
  const relayCapabilities = await runtime.supportedCapabilities(DEVELOPER_RELAY_CAPABILITIES);
  console.error(`[operator] relay capabilities: ${relayCapabilities.join(', ') || 'none'}`);
}

const emergencyStatus = await emergencyStop.status();
if (relayUrl && emergencyStatus.engaged) {
  if (relayRequired) {
    await failRequiredRelay(new OperatorError(
      'RELAY_REQUIRED_EMERGENCY_STOP',
      'The required relay cannot start while the local emergency stop is engaged.'
    ));
  }
} else if (relayUrl) {
  try { startRelay(); }
  catch (error) {
    console.error(`[operator] relay startup failed: ${error instanceof Error ? error.message : String(error)}`);
    await failRequiredRelay(error);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    void shutdownRuntime(0, signal.toLowerCase()).finally(() => process.exit(0));
  });
}

function launcherShutdownSignal(input: unknown): 'SIGINT' | 'SIGTERM' | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (raw.type !== 'mecord-shutdown') return null;
  const keys = Object.keys(raw);
  if (keys.some((key) => key !== 'type' && key !== 'signal')) return null;
  return raw.signal === 'SIGINT' || raw.signal === 'SIGTERM' ? raw.signal : null;
}

function sendLauncherMessage(message: Record<string, unknown>): void {
  if (!remoteLauncherIpc || !process.connected || typeof process.send !== 'function') return;
  try { process.send(message); } catch { /* parent loss is handled by the disconnect lifecycle */ }
}

function loopbackAddressForBoundHost(hostInput: string): string {
  const host = hostInput.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '::1' || host === '::') return '[::1]';
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === 'localhost' || host === '127.0.0.1') return host;
  throw new Error('Relay integration requires the local agent to bind to loopback or a wildcard interface so it can re-enter through the local policy boundary.');
}
