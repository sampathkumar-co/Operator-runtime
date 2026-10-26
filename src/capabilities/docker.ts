import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import type { ActionRequest, ActionResult, CapabilityExecutionContext, CapabilityProvider, CapabilityScore, ProviderReconciliationResult } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { resolveTrustedExecutable } from '../core/trusted-executable.ts';
import { PathScope } from './path-scope.ts';

const SCORE: CapabilityScore = {
  reliability: 0.98,
  latency: 0.9,
  determinism: 0.98,
  security: 0.96,
  reversibility: 0.72,
  informationQuality: 0.99,
  interactionCost: 0.01
};

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_CONTAINERS = 100;
const MAX_SERVICES = 50;
const INSPECT_FORMAT = '{{json .Id}}\t{{json .Name}}\t{{json .Config.Image}}\t{{json .State.Status}}\t{{json (index .Config.Labels "com.docker.compose.project")}}\t{{json (index .Config.Labels "com.docker.compose.service")}}\t{{json (index .Config.Labels "com.docker.compose.project.working_dir")}}';

type DockerOutput = { code: number; stdout: string; stderr: string; truncated: boolean };
type DockerContext = { name: string; host: string };
type ComposeContainer = {
  id: string;
  name: string;
  image: string;
  state: string;
  project: string;
  service: string;
  workingDir: string;
};

type ProjectState = {
  root: string;
  context: DockerContext;
  containers: ComposeContainer[];
  fingerprint: string;
};

export class DockerProvider implements CapabilityProvider {
  readonly name = 'docker.local.semantic';
  #scope: PathScope;
  #dockerExecutable: string;
  #dockerArgsPrefix: string[];

  constructor(options: { allowedRoots: string[]; dockerExecutable?: string; dockerArgsPrefix?: string[] }) {
    this.#scope = new PathScope(options.allowedRoots);
    this.#dockerExecutable = options.dockerExecutable ?? 'docker';
    this.#dockerArgsPrefix = options.dockerArgsPrefix ?? [];
  }

  supports(action: ActionRequest): boolean {
    return action.capability === 'docker.inspect' || action.capability === 'docker.manage';
  }

  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest, executionContext: CapabilityExecutionContext = {}): Promise<ActionResult> {
    const started = performance.now();
    try {
      if (!this.supports(action)) throw new OperatorError('UNSUPPORTED_ACTION', 'Docker provider does not support the requested capability.');
      if (action.capability === 'docker.inspect') {
        const pathValue = action.input.path;
        if (pathValue !== undefined && (typeof pathValue !== 'string' || pathValue.length > 4096)) {
          throw new OperatorError('INVALID_DOCKER_PROJECT_PATH', 'Docker project scope must be an exact bounded string.');
        }
        const rootInput = pathValue === undefined ? '' : (pathValue as string).trim();
        if (rootInput) {
          const state = await this.#inspectProject(rootInput, executionContext.signal);
          return success(action, started, {
            scope: 'project',
            root: state.root,
            context: { ...state.context, local: true },
            containers: state.containers.map(publicContainer),
            services: summarizeServices(state.containers),
            fingerprint: state.fingerprint
          }, [
            evidence('docker_context', 'pass', 'Docker context resolves to a local-only endpoint.', state.context),
            evidence('docker_project', 'pass', 'Compose containers were matched from Docker-owned labels without parsing repository Compose configuration.', {
              root: state.root,
              containerCount: state.containers.length,
              serviceCount: new Set(state.containers.map((item) => item.service)).size
            })
          ]);
        }

        const context = await this.#localContext(executionContext.signal);
        const serverVersion = await this.#serverVersion(context, executionContext.signal);
        const containers = await this.#listDaemonContainers(context, executionContext.signal);
        return success(action, started, {
          scope: 'daemon',
          context: { ...context, local: true },
          serverVersion,
          containers: containers.items,
          truncated: containers.truncated
        }, [
          evidence('docker_context', 'pass', 'Docker context resolves to a local-only endpoint.', context),
          evidence('docker_daemon', 'pass', 'Read bounded Docker daemon/container state without returning commands, environment variables, mounts, or arbitrary labels.', {
            containerCount: containers.items.length,
            truncated: containers.truncated
          })
        ]);
      }

      const operation = typeof action.input.operation === 'string' ? action.input.operation : '';
      if (!['start', 'stop', 'restart'].includes(operation)) {
        throw new OperatorError('INVALID_DOCKER_OPERATION', 'Docker manage operation must be start, stop, or restart.');
      }
      const services = validateServices(action.input.services);
      const timeoutMs = boundedInteger(action.input.timeoutMs, 60_000, 1_000, 5 * 60_000);
      const expectedCurrentFingerprint = action.input.expectedCurrentFingerprint;
      if (typeof expectedCurrentFingerprint !== 'string') {
        throw new OperatorError('DOCKER_FINGERPRINT_REQUIRED', 'A typed fingerprint from fresh docker.inspect is required.');
      }
      if (!/^[0-9a-f]{64}$/i.test(expectedCurrentFingerprint)) {
        throw new OperatorError('DOCKER_FINGERPRINT_REQUIRED', 'A fresh expectedCurrentFingerprint from docker.inspect is required.');
      }

      const projectPath = action.input.path;
      if (typeof projectPath !== 'string' || !projectPath.trim() || projectPath.length > 4096) {
        throw new OperatorError('INVALID_DOCKER_PROJECT_PATH', 'Docker manage requires an exact non-empty authorized project path.');
      }
      const before = await this.#inspectProject(projectPath, executionContext.signal);
      if (before.fingerprint !== expectedCurrentFingerprint) {
        throw new OperatorError('DOCKER_STATE_CHANGED', 'Docker project state changed after the supplied precondition was captured.', {
          retryable: true,
          details: {
            expectedCurrentFingerprint,
            actualCurrentFingerprint: before.fingerprint,
            sideEffectState: 'none',
            executionPhase: 'pre_dispatch'
          }
        });
      }

      const selected = before.containers.filter((container) => services.includes(container.service));
      const missing = services.filter((service) => !selected.some((container) => container.service === service));
      if (missing.length > 0) {
        throw new OperatorError('DOCKER_SERVICE_NOT_CREATED', 'Every requested service must already have at least one Compose-created container.', {
          details: { missing }
        });
      }
      const ids = [...new Set(selected.map((container) => container.id))].sort();
      // Expected fingerprint may have been captured before the project read,
      // but even that read can race with a container replacement. Re-inspect
      // immediately before the Docker mutation and refuse changed ownership.
      const preDispatch = await this.#inspectProject(before.root, executionContext.signal);
      if (preDispatch.fingerprint !== before.fingerprint) {
        throw new OperatorError('DOCKER_STATE_CHANGED', 'Compose container identity/state changed immediately before dispatch.', {
          retryable: true,
          details: { sideEffectState: 'none', executionPhase: 'pre_dispatch' }
        });
      }
      await this.#run(before.context, [operation, ...ids], timeoutMs, executionContext.signal);

      const after = await this.#inspectProject(before.root, executionContext.signal);
      assertManagedComposeIdentity(ids, services, after.containers);
      verifyLifecyclePostcondition(operation, services, after.containers);
      return success(action, started, {
        operation,
        root: before.root,
        services,
        containerIds: ids.map((id) => id.slice(0, 12)),
        beforeFingerprint: before.fingerprint,
        afterFingerprint: after.fingerprint,
        states: summarizeServices(after.containers.filter((container) => services.includes(container.service)))
      }, [
        evidence('docker_lifecycle', 'pass', `Docker ${operation} completed for already-created Compose service containers.`, {
          services,
          containerCount: ids.length
        }),
        evidence('postcondition', 'pass', 'Docker container states were re-inspected after lifecycle management.', {
          beforeFingerprint: before.fingerprint,
          afterFingerprint: after.fingerprint
        })
      ]);
    } catch (error) {
      const op = error instanceof OperatorError
        ? error
        : new OperatorError('DOCKER_ERROR', error instanceof Error ? error.message : String(error), { retryable: true });
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [evidence('docker', 'fail', op.message, { code: op.code })],
        error: {
          code: op.code,
          message: op.message,
          retryable: op.retryable,
          ...(op.details && ['none', 'known', 'uncertain'].includes(String(op.details.sideEffectState))
            ? { sideEffectState: op.details.sideEffectState as 'none' | 'known' | 'uncertain' }
            : {}),
          ...(op.details && ['pre_dispatch', 'dispatched', 'effect_observed', 'reconciled'].includes(String(op.details.executionPhase))
            ? { executionPhase: op.details.executionPhase as 'pre_dispatch' | 'dispatched' | 'effect_observed' | 'reconciled' }
            : {})
        },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }

  async reconcile(
    { action }: { action: ActionRequest; priorResult?: ActionResult },
    context: CapabilityExecutionContext = {}
  ): Promise<ProviderReconciliationResult> {
    if (action.capability !== 'docker.manage') {
      return reconciliation('uncertain', 'Docker reconciliation applies only to lifecycle mutations.');
    }
    const operation = action.input.operation;
    if (typeof operation !== 'string' || !['start', 'stop', 'restart'].includes(operation)) {
      return reconciliation('uncertain', 'Docker lifecycle operation is invalid for reconciliation.');
    }
    if (operation === 'restart') {
      return reconciliation('uncertain', 'A final running state cannot prove that a restart actually occurred.');
    }
    try {
      const services = validateServices(action.input.services);
      if (typeof action.input.path !== 'string' || !action.input.path.trim()) {
        return reconciliation('uncertain', 'Docker reconcile requires an exact previously approved project path.');
      }
      const state = await this.#inspectProject(action.input.path, context.signal);
      const selected = state.containers.filter((container) => services.includes(container.service));
      const missing = services.filter((service) => !selected.some((container) => container.service === service));
      if (missing.length > 0) {
        return reconciliation('uncertain', 'One or more requested Compose services is missing during reconciliation.');
      }
      const expected = operation === 'stop' ? 'exited' : 'running';
      const summaries = summarizeServices(selected);
      const states = summaries.flatMap((item) => item.states);
      if (states.length > 0 && states.every((value) => value === expected)) {
        const result: ActionResult = {
          ok: true,
          capability: action.capability,
          provider: this.name,
          output: {
            operation,
            root: state.root,
            services,
            afterFingerprint: state.fingerprint,
            states: summaries,
            reconciled: true
          },
          evidence: [
            evidence('docker_reconciliation', 'pass', `Fresh Docker inspection proves every requested service is ${expected}.`, { services }),
            evidence('postcondition', 'pass', 'Docker reconciliation used current project-scoped container state.', { fingerprint: state.fingerprint })
          ],
          durationMs: 0
        };
        return { status: 'completed', result, evidence: result.evidence };
      }
      const opposite = operation === 'stop' ? 'running' : 'exited';
      if (states.length > 0 && states.every((value) => value === opposite)) {
        return reconciliation('not_applied', `Fresh Docker inspection shows every requested service is still ${opposite}.`);
      }
      return reconciliation('uncertain', 'Requested Docker services are in mixed states and cannot be reconciled safely.');
    } catch (error) {
      return reconciliation('uncertain', error instanceof Error ? error.message : 'Docker reconciliation failed.');
    }
  }

  async #localContext(signal?: AbortSignal): Promise<DockerContext> {
    const shown = await this.#runRaw(['context', 'show'], 15_000, signal);
    const name = shown.stdout.trim();
    if (!name || name.length > 256 || /[\r\n\0]/.test(name)) {
      throw new OperatorError('DOCKER_CONTEXT_INVALID', 'Docker returned an invalid active context name.');
    }
    const inspected = await this.#runRaw(['context', 'inspect', name, '--format', '{{json .Endpoints.docker.Host}}'], 15_000, signal);
    let host: string;
    try { host = JSON.parse(inspected.stdout.trim()) as string; } catch {
      throw new OperatorError('DOCKER_CONTEXT_INVALID', 'Docker context endpoint could not be parsed.');
    }
    if (typeof host !== 'string' || !isLocalDockerHost(host)) {
      throw new OperatorError('REMOTE_DOCKER_CONTEXT_DENIED', 'Operator Docker adapter permits only local Unix sockets, Windows named pipes, or loopback TCP endpoints by default.', {
        details: { context: name, host }
      });
    }
    return { name, host };
  }

  async #serverVersion(context: DockerContext, signal?: AbortSignal): Promise<string> {
    const result = await this.#run(context, ['version', '--format', '{{json .Server.Version}}'], 15_000, signal);
    try {
      const version = JSON.parse(result.stdout.trim());
      return typeof version === 'string' ? version.slice(0, 128) : '';
    } catch { return result.stdout.trim().slice(0, 128); }
  }

  async #listDaemonContainers(context: DockerContext, signal?: AbortSignal): Promise<{ items: Array<Record<string, unknown>>; truncated: boolean }> {
    const result = await this.#run(context, ['ps', '--all', '--format', '{{json .}}'], 20_000, signal);
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    const items: Array<Record<string, unknown>> = [];
    for (const line of lines.slice(0, MAX_CONTAINERS)) {
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        items.push({
          id: String(raw.ID ?? '').slice(0, 12),
          name: String(raw.Names ?? '').slice(0, 256),
          image: String(raw.Image ?? '').slice(0, 512),
          state: String(raw.State ?? '').slice(0, 64),
          status: String(raw.Status ?? '').slice(0, 256),
          ports: String(raw.Ports ?? '').slice(0, 1024)
        });
      } catch {
        throw new OperatorError('DOCKER_OUTPUT_INVALID', 'Docker container JSON output could not be parsed.');
      }
    }
    return { items, truncated: lines.length > MAX_CONTAINERS || result.truncated };
  }

  async #inspectProject(inputPath: string, signal?: AbortSignal): Promise<ProjectState> {
    const root = await this.#scope.resolveExisting(inputPath);
    const context = await this.#localContext(signal);
    const listed = await this.#run(context, ['ps', '--all', '--filter', 'label=com.docker.compose.project', '--format', '{{json .ID}}'], 20_000, signal);
    const lines = listed.stdout.split(/\r?\n/).filter(Boolean);
    // Project lifecycle authority depends on an exhaustive Compose inventory.
    // Truncating the global list can omit same-project containers and produce
    // an incomplete fingerprint that appears valid at dispatch/reconciliation.
    if (listed.truncated || lines.length > MAX_CONTAINERS) {
      throw new OperatorError('DOCKER_PROJECT_INVENTORY_INCOMPLETE',
        'Docker returned an incomplete Compose inventory; no project lifecycle action is safe.');
    }
    const seenIds = new Set<string>();
    const ids = lines.map((line) => {
      let id: unknown;
      try { id = JSON.parse(line) as unknown; } catch {
        throw new OperatorError('DOCKER_PROJECT_INVENTORY_INVALID',
          'Docker returned a malformed Compose container identifier.');
      }
      if (typeof id !== 'string' || !/^[0-9a-f]{12,64}$/i.test(id) || seenIds.has(id.toLowerCase())) {
        throw new OperatorError('DOCKER_PROJECT_INVENTORY_INVALID',
          'Docker returned an invalid or duplicated Compose container identifier.');
      }
      seenIds.add(id.toLowerCase());
      return id;
    });

    const containers = ids.length === 0 ? [] : await this.#inspectComposeContainers(context, ids, signal);
    const matched = containers
      .filter((container) => sameLocalPath(container.workingDir, root))
      .sort((a, b) => `${a.service}\0${a.id}`.localeCompare(`${b.service}\0${b.id}`));
    return {
      root,
      context,
      containers: matched,
      fingerprint: fingerprintProject(context, matched)
    };
  }

  async #inspectComposeContainers(context: DockerContext, ids: string[], signal?: AbortSignal): Promise<ComposeContainer[]> {
    const result = await this.#run(context, ['inspect', '--format', INSPECT_FORMAT, ...ids], 30_000, signal);
    if (result.truncated) {
      throw new OperatorError('DOCKER_PROJECT_INVENTORY_INCOMPLETE',
        'Docker inspect output was truncated and cannot establish complete container identities.');
    }
    const expectedPrefixes = ids.map((id) => id.slice(0, 12).toLowerCase());
    if (new Set(expectedPrefixes).size !== ids.length) {
      throw new OperatorError('DOCKER_PROJECT_INVENTORY_INVALID',
        'Docker returned ambiguous abbreviated Compose container identities.');
    }
    const seenPrefixes = new Set<string>();
    const containers: ComposeContainer[] = [];
    for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
      const fields = line.split('\t');
      if (fields.length !== 7) throw new OperatorError('DOCKER_OUTPUT_INVALID', 'Docker inspect output had an unexpected shape.');
      const parsed = fields.map((field) => {
        try { return JSON.parse(field) as unknown; } catch { throw new OperatorError('DOCKER_OUTPUT_INVALID', 'Docker inspect field was not valid JSON.'); }
      });
      const [id, rawName, image, state, project, service, workingDir] = parsed.map((value) => typeof value === 'string' ? value : '');
      const prefix = id.slice(0, 12).toLowerCase();
      if (!/^[0-9a-f]{12,64}$/i.test(id) || !project || !service || !workingDir ||
          !expectedPrefixes.includes(prefix) || seenPrefixes.has(prefix)) {
        throw new OperatorError('DOCKER_PROJECT_INVENTORY_INVALID',
          'Docker inspect returned missing, foreign, invalid or duplicated Compose container identity.');
      }
      seenPrefixes.add(prefix);
      containers.push({
        id,
        name: rawName.replace(/^\//, '').slice(0, 256),
        image: image.slice(0, 512),
        state: state.toLowerCase().slice(0, 64),
        project: project.slice(0, 256),
        service: service.slice(0, 256),
        workingDir
      });
    }
    if (seenPrefixes.size !== ids.length) {
      throw new OperatorError('DOCKER_PROJECT_INVENTORY_INCOMPLETE',
        'Docker inspect omitted one or more requested Compose container identities.');
    }
    return containers;
  }

  async #run(context: DockerContext, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<DockerOutput> {
    return this.#runRaw(['--context', context.name, ...args], timeoutMs, signal);
  }

  async #runRaw(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<DockerOutput> {
    return await runDocker(this.#dockerExecutable, [...this.#dockerArgsPrefix, ...args], timeoutMs, signal);
  }
}

function boundedInteger(input: unknown, fallback: number, min: number, max: number): number {
  if (input === undefined) return fallback;
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) {
    throw new OperatorError('INVALID_DOCKER_TIMEOUT', 'Docker timeout must be an exact bounded integer in milliseconds.');
  }
  return input;
}

function validateServices(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_SERVICES) {
    throw new OperatorError('DOCKER_SERVICES_REQUIRED', `services must contain 1-${MAX_SERVICES} Compose service names.`);
  }
  if (input.some(service => typeof service !== 'string')) {
    throw new OperatorError('INVALID_DOCKER_SERVICE', 'Docker service identity must be an exact string.');
  }
  const services = [...new Set(input as string[])];
  for (const service of services) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(service)) {
      throw new OperatorError('INVALID_DOCKER_SERVICE', 'Docker service names must use bounded alphanumeric/._- characters.');
    }
  }
  return services;
}

function publicContainer(container: ComposeContainer): Record<string, unknown> {
  return {
    id: container.id.slice(0, 12),
    name: container.name,
    image: container.image,
    state: container.state,
    project: container.project,
    service: container.service
  };
}

function summarizeServices(containers: ComposeContainer[]): Array<{ service: string; containers: number; states: string[] }> {
  const grouped = new Map<string, ComposeContainer[]>();
  for (const container of containers) grouped.set(container.service, [...(grouped.get(container.service) ?? []), container]);
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([service, items]) => ({
    service,
    containers: items.length,
    states: [...new Set(items.map((item) => item.state))].sort()
  }));
}

/** Post-dispatch success is not provable if the service now refers to
 * different containers, even if the replacements happen to be running. */
export function assertManagedComposeIdentity(
  expectedIds: readonly string[],
  services: readonly string[],
  observed: readonly { id: string; service: string }[]
): void {
  const exact = [...new Set(expectedIds)].sort();
  const current = [...new Set(observed
    .filter(container => services.includes(container.service))
    .map(container => container.id))].sort();
  if (!exact.length || current.length !== exact.length ||
      exact.some((id,index) => id !== current[index])) {
    throw new OperatorError('DOCKER_CONTAINER_IDENTITY_CHANGED',
      'Compose service container ownership changed while Docker mutation was in flight; operation outcome requires independent recovery.', {
        retryable: false,
        details: { sideEffectState: 'uncertain', executionPhase: 'effect_observed',
          expectedContainerCount: exact.length, observedContainerCount: current.length }
      });
  }
}

function verifyLifecyclePostcondition(operation: string, services: string[], containers: ComposeContainer[]): void {
  for (const service of services) {
    const states = containers.filter((container) => container.service === service).map((container) => container.state);
    if (states.length === 0) throw new OperatorError('DOCKER_POSTCONDITION_FAILED', `Service ${service} disappeared after Docker ${operation}.`);
    const valid = operation === 'stop'
      ? states.every((state) => state === 'exited')
      : states.every((state) => state === 'running');
    if (!valid) {
      throw new OperatorError('DOCKER_POSTCONDITION_FAILED', `Service ${service} did not reach the expected state after Docker ${operation}.`, {
        details: { service, operation, states }
      });
    }
  }
}

function fingerprintProject(context: DockerContext, containers: ComposeContainer[]): string {
  const payload = JSON.stringify({
    context,
    containers: containers.map(({ id, name, image, state, project, service }) => ({ id, name, image, state, project, service }))
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function sameLocalPath(candidate: string, root: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  const left = path.normalize(path.resolve(candidate));
  const right = path.normalize(path.resolve(root));
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isLocalDockerHost(host: string): boolean {
  if (/^unix:\/\/\//i.test(host)) return path.posix.isAbsolute(host.slice('unix://'.length));
  if (/^npipe:\/\//i.test(host)) {
    const pipePath = host.slice('npipe://'.length).replace(/\\/g, '/');
    return /^(?:\/\/)?\.\/pipe\/[A-Za-z0-9_.-]+$/i.test(pipePath);
  }
  if (/^tcp:\/\//i.test(host)) {
    try {
      const url = new URL(`http://${host.slice('tcp://'.length)}`);
      const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    } catch { return false; }
  }
  return false;
}

function dockerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { COMPOSE_DISABLE_ENV_FILE: '1' };
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function reconciliation(status: ProviderReconciliationResult['status'], message: string): ProviderReconciliationResult {
  return {
    status,
    evidence: [evidence('docker_reconciliation', status === 'completed' ? 'pass' : 'info', message)]
  };
}

async function runDocker(executable: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<DockerOutput> {
  return await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OperatorError('EXECUTION_ABORTED', 'Docker execution was cancelled.', { retryable: false }));
      return;
    }
    const environment = dockerEnvironment();
    const dockerExecutable = resolveTrustedExecutable(executable, environment);
    const child = spawn(dockerExecutable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const capture = (bucket: Buffer[]) => (chunk: Buffer) => {
      if (bytes >= MAX_OUTPUT_BYTES) { truncated = true; return; }
      const sliced = chunk.subarray(0, MAX_OUTPUT_BYTES - bytes);
      bucket.push(sliced);
      bytes += sliced.byteLength;
      if (sliced.byteLength < chunk.byteLength) truncated = true;
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.once('error', reject);
    const terminate = () => {
      try { child.kill('SIGTERM'); } catch { /* child may already be gone */ }
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* child may already be gone */ }
        }, 1000);
        forceKillTimer.unref();
      }
    };
    const onAbort = () => { aborted = true; terminate(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref();
    child.once('close', (code) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', onAbort);
      if (aborted) {
        reject(new OperatorError('EXECUTION_ABORTED', 'Docker execution was cancelled.', { retryable: false }));
        return;
      }
      if (timedOut) {
        reject(new OperatorError('DOCKER_TIMEOUT', `Docker command exceeded ${timeoutMs}ms timeout.`, { retryable: true }));
        return;
      }
      const output = {
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated
      };
      if (output.code !== 0) {
        reject(new OperatorError('DOCKER_COMMAND_FAILED', output.stderr.trim().slice(0, 1200) || `Docker exited with code ${output.code}.`));
        return;
      }
      resolve(output);
    });
  });
}

function success(action: ActionRequest, started: number, output: unknown, extraEvidence: ReturnType<typeof evidence>[]): ActionResult {
  return {
    ok: true,
    capability: action.capability,
    provider: 'docker.local.semantic',
    output,
    evidence: extraEvidence,
    durationMs: Math.round(performance.now() - started)
  };
}
