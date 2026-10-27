import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ActionRequest, ActionResult, CapabilityExecutionContext, CapabilityProvider, CapabilityScore, ProviderReconciliationRequest, ProviderReconciliationResult } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { safeChildEnvironment } from '../core/child-environment.ts';
import { BrowserCdpProvider, boundedDiscoveryJson } from './browser-cdp.ts';
import { assertLoopbackEndpoint } from './browser-cdp-page.ts';

const SCORE: CapabilityScore = {
  reliability: 0.95,
  latency: 0.94,
  determinism: 0.97,
  security: 0.96,
  reversibility: 0.95,
  informationQuality: 0.96,
  interactionCost: 0.015
};

const RECOVERABLE_CDP_CODES = new Set([
  'CDP_UNAVAILABLE',
  'CDP_HTTP_ERROR',
  'CDP_CONNECT_FAILED',
  'CDP_CONNECT_TIMEOUT',
  'CDP_CONNECTION_CLOSED',
  'CDP_BROWSER_TARGET_UNAVAILABLE',
  'CDP_TARGET_UNAVAILABLE'
]);

export type ManagedBrowserOptions = {
  endpoint?: string;
  autoLaunch?: boolean;
  executablePath?: string;
  dataDir?: string;
  discoveryDataDirs?: string[];
  launchTimeoutMs?: number;
  /**
   * Opt-in ownership fence: launch a dedicated child using an explicitly supplied,
   * isolated dataDir. Do not attach to configured/discovered/user Chrome sessions.
   * The default remains unchanged for existing installations.
   */
  dedicatedProfileOnly?: boolean;
  launcher?: BrowserEndpointLauncher;
  /** Test/integration seam for a protocol-compatible CDP delegate. */
  delegate?: CapabilityProvider;
};

export type BrowserEndpointLauncher = {
  ensureEndpoint(): Promise<string>;
  close(): void | Promise<void>;
};

export function candidateBrowserPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const values: string[] = [];
  const add = (value: string | undefined) => { if (value && !values.includes(value)) values.push(value); };

  if (platform === 'win32') {
    for (const root of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]) {
      if (!root) continue;
      add(path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      add(path.win32.join(root, 'Google', 'Chrome for Testing', 'Application', 'chrome.exe'));
      add(path.win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (platform === 'darwin') {
    add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    add('/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    add('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    add('/usr/bin/google-chrome');
    add('/usr/bin/google-chrome-stable');
    add('/usr/bin/chromium');
    add('/usr/bin/chromium-browser');
    add('/usr/bin/microsoft-edge');
    add('/usr/bin/microsoft-edge-stable');
  }
  return values;
}

export function candidateBrowserDataDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, homeDir: string): string[] {
  const values: string[] = [];
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const add = (value: string | undefined) => {
    if (!value || !pathApi.isAbsolute(value) || value === pathApi.parse(value).root || values.includes(value)) return;
    values.push(value);
  };

  if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    if (local) {
      add(pathApi.join(local, 'Google', 'Chrome', 'User Data'));
      add(pathApi.join(local, 'Google', 'Chrome Beta', 'User Data'));
      add(pathApi.join(local, 'Google', 'Chrome SxS', 'User Data'));
      add(pathApi.join(local, 'Microsoft', 'Edge', 'User Data'));
      add(pathApi.join(local, 'Microsoft', 'Edge Beta', 'User Data'));
      add(pathApi.join(local, 'Microsoft', 'Edge Dev', 'User Data'));
    }
  } else if (platform === 'darwin') {
    add(pathApi.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome'));
    add(pathApi.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome Beta'));
    add(pathApi.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome Canary'));
    add(pathApi.join(homeDir, 'Library', 'Application Support', 'Microsoft Edge'));
    add(pathApi.join(homeDir, 'Library', 'Application Support', 'Microsoft Edge Beta'));
    add(pathApi.join(homeDir, 'Library', 'Application Support', 'Microsoft Edge Dev'));
  } else {
    add(pathApi.join(homeDir, '.config', 'google-chrome'));
    add(pathApi.join(homeDir, '.config', 'google-chrome-beta'));
    add(pathApi.join(homeDir, '.config', 'google-chrome-unstable'));
    add(pathApi.join(homeDir, '.config', 'chromium'));
    add(pathApi.join(homeDir, '.config', 'microsoft-edge'));
    add(pathApi.join(homeDir, '.config', 'microsoft-edge-beta'));
    add(pathApi.join(homeDir, '.config', 'microsoft-edge-dev'));
  }
  return values;
}

export function buildManagedBrowserArgs(dataDir: string, options: { headless?: boolean } = {}): string[] {
  const resolved = path.resolve(dataDir);
  if (!path.isAbsolute(dataDir) || resolved === path.parse(resolved).root) {
    throw new OperatorError('UNSAFE_BROWSER_DATA_DIR', 'Managed browser data directory must be a non-root absolute path.');
  }
  return [
    '--remote-debugging-port=0',
    `--user-data-dir=${resolved}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(options.headless ? ['--headless=new'] : []),
    'about:blank'
  ];
}

export function parseDevToolsActivePort(raw: string): { port: number; browserPath: string; endpoint: string } {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const port = Number(lines[0]);
  const browserPath = lines[1] ?? '';
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new OperatorError('INVALID_DEVTOOLS_ACTIVE_PORT', 'DevToolsActivePort contains an invalid TCP port.');
  }
  if (!/^\/devtools\/browser\/[A-Za-z0-9._:-]+$/.test(browserPath)) {
    throw new OperatorError('INVALID_DEVTOOLS_ACTIVE_PORT', 'DevToolsActivePort contains an invalid browser WebSocket path.');
  }
  return { port, browserPath, endpoint: `http://127.0.0.1:${port}` };
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

async function endpointHealthy(endpoint: string): Promise<boolean> {
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  try { assertLoopbackEndpoint(url); } catch { return false; }
  try {
    const response = await fetch(new URL('/json/version', url), { redirect: 'error', signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return false;
    const payload = await boundedDiscoveryJson(response) as { Browser?: unknown; webSocketDebuggerUrl?: unknown };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (typeof payload.Browser !== 'string' || !/(Chrome|Chromium|Edg)/i.test(payload.Browser)) return false;
    if (typeof payload.webSocketDebuggerUrl !== 'string') return false;
    const websocket = new URL(payload.webSocketDebuggerUrl);
    if (websocket.protocol !== 'ws:' || !isLoopbackHost(websocket.hostname)) return false;
    if (!/^\/devtools\/browser\/[A-Za-z0-9._:-]+$/.test(websocket.pathname)) return false;
    if (websocket.port && url.port && websocket.port !== url.port) return false;
    return true;
  } catch { return false; }
}

export async function discoverDevToolsEndpoint(dataDirs: string[]): Promise<{ endpoint: string; dataDir: string } | undefined> {
  const seen = new Set<string>();
  for (const candidate of dataDirs) {
    if (!path.isAbsolute(candidate)) continue;
    const dataDir = path.resolve(candidate);
    if (dataDir === path.parse(dataDir).root || seen.has(dataDir)) continue;
    seen.add(dataDir);
    try {
      const raw = await fs.readFile(path.join(dataDir, 'DevToolsActivePort'), 'utf8');
      const parsed = parseDevToolsActivePort(raw);
      if (await endpointHealthy(parsed.endpoint)) return { endpoint: parsed.endpoint, dataDir };
    } catch { /* absent, stale, or malformed candidate; try the next bounded root */ }
  }
  return undefined;
}

/**
 * Dedicated mode requires an independent, explicit profile directory and a new
 * child process. Existing CDP ports, user browser roots, and protected runtime
 * state are never implicitly reused.
 */
function assertDedicatedProfileOptions(options: ManagedBrowserOptions): void {
  if (options.endpoint || options.discoveryDataDirs?.length || options.autoLaunch === false
      || options.launcher || options.delegate || !options.dataDir || !path.isAbsolute(options.dataDir)) {
    throw new OperatorError('BROWSER_DEDICATED_OWNERSHIP_INVALID',
      'Dedicated mode requires an explicit absolute dataDir and managed child launch, without external endpoint, discovery, or delegate injection.');
  }
  const resolved = path.resolve(options.dataDir);
  const forbidden = [
    ...candidateBrowserDataDirs(process.platform, process.env, os.homedir()),
    path.join(os.homedir(), '.operator')
  ];
  for (const root of forbidden) {
    const relative = path.relative(root, resolved);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw new OperatorError('BROWSER_DEDICATED_PROFILE_FORBIDDEN',
        'Dedicated profile must not reuse a standard browser profile or protected runtime directory.');
    }
  }
  if (resolved === path.parse(resolved).root) {
    throw new OperatorError('BROWSER_DEDICATED_PROFILE_FORBIDDEN', 'Dedicated profile must not be a filesystem root.');
  }
}

export class ManagedChromiumLauncher implements BrowserEndpointLauncher {
  #options: ManagedBrowserOptions;
  #child?: ChildProcess;
  #launchedEndpoint?: string;
  #dedicatedEnsureInFlight?: Promise<string>;

  constructor(options: ManagedBrowserOptions = {}) {
    this.#options = options;
  }

  async ensureEndpoint(): Promise<string> {
    if (this.#options.dedicatedProfileOnly) {
      assertDedicatedProfileOptions(this.#options);
      if (this.#dedicatedEnsureInFlight) return await this.#dedicatedEnsureInFlight;
      const attempt = this.#ensureDedicatedEndpoint();
      this.#dedicatedEnsureInFlight = attempt;
      try { return await attempt; }
      finally {
        if (this.#dedicatedEnsureInFlight === attempt) this.#dedicatedEnsureInFlight = undefined;
      }
    }
    const configured = this.#options.endpoint ?? 'http://127.0.0.1:9222';
    if (await endpointHealthy(configured)) return configured;
    if (this.#launchedEndpoint && await endpointHealthy(this.#launchedEndpoint)) return this.#launchedEndpoint;

    const discovered = await discoverDevToolsEndpoint(this.#discoveryDataDirs());
    if (discovered) {
      this.#launchedEndpoint = discovered.endpoint;
      return discovered.endpoint;
    }

    if (this.#options.autoLaunch === false) {
      throw new OperatorError('BROWSER_ENDPOINT_UNAVAILABLE', 'No healthy configured or discoverable local Chromium CDP endpoint is available and managed auto-launch is disabled.', { retryable: true });
    }

    return await this.#launchDedicated();
  }

  async #ensureDedicatedEndpoint(): Promise<string> {
      if (this.#child && this.#child.exitCode === null && this.#child.signalCode === null
          && this.#launchedEndpoint && await endpointHealthy(this.#launchedEndpoint)) {
        return this.#launchedEndpoint;
      }
      // No configured/discovered endpoint can prove child-process ownership.
      // Retire only a child owned by this launcher before any fresh spawn.
      if (this.#child) await this.#terminateChild();
      return await this.#launchDedicated();
  }

  async #launchDedicated(): Promise<string> {
    const executable = await this.#resolveExecutable();
    const dataDir = this.#managedDataDir();
    const args = buildManagedBrowserArgs(dataDir, { headless: this.#options.dedicatedProfileOnly });
    if (this.#options.dedicatedProfileOnly) {
      // The owner must provision a distinct directory in advance. Never mkdir
      // through a symlinked parent and accidentally modify protected profiles.
      // Realpath checks also catch aliases/junctions that bypass lexical checks.
      let profile;
      try {
        profile = await fs.lstat(dataDir);
      } catch {
        throw new OperatorError('BROWSER_DEDICATED_PROFILE_NOT_PROVISIONED',
          'Dedicated browser profile directory must already exist and be owner-provisioned.');
      }
      if (profile.isSymbolicLink() || !profile.isDirectory()) {
        throw new OperatorError('BROWSER_DEDICATED_PROFILE_SYMLINK',
          'Dedicated Chrome profile must be a real directory, not a symlink or file.');
      }
      const actualProfilePath = await fs.realpath(dataDir);
      assertDedicatedProfileOptions({ ...this.#options, dataDir: actualProfilePath });
    } else {
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    }
    const portFile = path.join(dataDir, 'DevToolsActivePort');
    if (this.#options.dedicatedProfileOnly) {
      // Use lstat, not stat: dangling symlinks must not be mistaken for absent
      // ownership files. Never remove an existing port file owned elsewhere.
      try {
        await fs.lstat(portFile);
        throw new OperatorError('BROWSER_DEDICATED_PROFILE_IN_USE',
          'Dedicated browser profile already has DevToolsActivePort; refuse to overwrite a potentially active owner.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
    } else {
      await fs.rm(portFile, { force: true });
    }

    const child = spawn(executable, args, {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
      env: safeChildEnvironment('desktop')
    });
    this.#child = child;

    const timeoutMs = Math.min(Math.max(this.#options.launchTimeoutMs ?? 12_000, 2_000), 60_000);
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new OperatorError('BROWSER_LAUNCH_FAILED', `Managed browser exited before exposing CDP (exit ${child.exitCode}).`, { retryable: true });
      }
      try {
        const parsed = parseDevToolsActivePort(await fs.readFile(portFile, 'utf8'));
        if (await endpointHealthy(parsed.endpoint)) {
          this.#launchedEndpoint = parsed.endpoint;
          return parsed.endpoint;
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 75));
    }

    await this.#terminateChild();
    throw new OperatorError('BROWSER_LAUNCH_TIMEOUT', 'Managed browser did not expose a healthy CDP endpoint before timeout.', {
      retryable: true,
      details: { cause: lastError instanceof Error ? lastError.message : undefined }
    });
  }

  async close(): Promise<void> {
    if (this.#dedicatedEnsureInFlight) {
      await this.#dedicatedEnsureInFlight.catch(() => undefined);
    }
    await this.#terminateChild();
  }

  #managedDataDir(): string {
    return path.resolve(this.#options.dataDir ?? path.join(os.homedir(), '.operator', 'browser-profile'));
  }

  #discoveryDataDirs(): string[] {
    const values: string[] = [];
    for (const candidate of this.#options.discoveryDataDirs ?? []) {
      if (!path.isAbsolute(candidate)) {
        throw new OperatorError('UNSAFE_BROWSER_DISCOVERY_DIR', 'Browser discovery data directories must be absolute paths.');
      }
      values.push(path.resolve(candidate));
    }
    values.push(this.#managedDataDir());
    // Do not auto-attach to normal Chrome/Edge user profiles. A configured CDP endpoint
    // or an explicit discoveryDataDirs entry is required for non-managed profiles.
    return values;
  }

  async #resolveExecutable(): Promise<string> {
    const explicit = this.#options.executablePath;
    if (explicit) {
      if (!path.isAbsolute(explicit)) throw new OperatorError('UNSAFE_BROWSER_EXECUTABLE', 'Configured browser executable path must be absolute.');
      try { await fs.access(explicit); return explicit; } catch {
        throw new OperatorError('BROWSER_EXECUTABLE_NOT_FOUND', 'Configured browser executable does not exist.', { details: { path: explicit } });
      }
    }

    for (const candidate of candidateBrowserPaths(process.platform, process.env)) {
      try { await fs.access(candidate); return candidate; } catch { /* next candidate */ }
    }
    throw new OperatorError('BROWSER_EXECUTABLE_NOT_FOUND', 'Chrome, Chrome for Testing, Chromium, or Edge was not found. Configure OPERATOR_BROWSER_PATH.', { retryable: false });
  }

  async #terminateChild(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    this.#launchedEndpoint = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await terminateManagedChild(child);
  }
}

export class ManagedBrowserProvider implements CapabilityProvider {
  readonly name = 'browser.managed';
  #dedicatedProfileOnly: boolean;
  #dedicatedBindInFlight?: Promise<void>;
  #delegate: CapabilityProvider;
  #launcher: BrowserEndpointLauncher;
  #endpoint: string;

  constructor(options: ManagedBrowserOptions = {}) {
    if (options.dedicatedProfileOnly) assertDedicatedProfileOptions(options);
    this.#dedicatedProfileOnly = options.dedicatedProfileOnly === true;
    // Strict mode must never make the first call against a user's default CDP port.
    this.#endpoint = this.#dedicatedProfileOnly ? 'http://127.0.0.1:1'
      : options.endpoint ?? 'http://127.0.0.1:9222';
    this.#delegate = options.delegate ?? new BrowserCdpProvider(this.#endpoint);
    this.#launcher = options.launcher ?? new ManagedChromiumLauncher(options);
  }

  supports(action: ActionRequest): boolean | Promise<boolean> {
    return this.#delegate.supports(action);
  }

  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest, context: CapabilityExecutionContext = {}): Promise<ActionResult> {
    const started = performance.now();
    if (this.#dedicatedProfileOnly) {
      // Establish process ownership before *any* read or mutation. Never route to
      // 9222, discovered profiles or a previously running unowned CDP server.
      let endpoint: string;
      try {
        endpoint = await this.#launcher.ensureEndpoint();
      } catch (error) {
        const op = error instanceof OperatorError ? error :
          new OperatorError('BROWSER_DEDICATED_LAUNCH_FAILED',
            'Dedicated browser could not establish an owned process.', { retryable: false });
        return { ok: false, capability: action.capability, provider: this.name,
          evidence: [evidence('browser_ownership', 'fail',
            'No dedicated browser process was available; refused to attach to another Chrome instance.',
            { code: op.code })],
          error: { code: op.code, message: op.message, retryable: false, sideEffectState: 'none' },
          durationMs: Math.round(performance.now() - started) };
      }
      if (endpoint !== this.#endpoint) {
        if (!this.#dedicatedBindInFlight) {
          const binding = (async () => {
            if (endpoint !== this.#endpoint) {
              await this.#delegate.close?.();
              this.#endpoint = endpoint;
              this.#delegate = new BrowserCdpProvider(endpoint);
            }
          })();
          this.#dedicatedBindInFlight = binding;
          void binding.finally(() => {
            if (this.#dedicatedBindInFlight === binding) this.#dedicatedBindInFlight = undefined;
          }).catch(() => undefined);
        }
        await this.#dedicatedBindInFlight;
      }
      // Delegate failures remain authoritative. Never reclassify a possibly
      // dispatched mutation as sideEffectState=none or implicitly replay it.
      const result = await this.#delegate.execute(action, context);
      return { ...result, provider: this.name };
    }
    const first = await this.#delegate.execute(action, context);
    if (first.ok || !first.error?.code || !RECOVERABLE_CDP_CODES.has(first.error.code)) {
      return { ...first, provider: this.name };
    }

    if (action.risk !== 'read') {
      return {
        ...first,
        provider: this.name,
        evidence: [
          ...first.evidence,
          evidence('browser_lifecycle', 'fail', 'Refused to replay a browser mutation after ambiguous CDP transport failure; explicit post-state reconciliation is required.', { code: first.error.code })
        ],
        error: { ...first.error, sideEffectState: 'uncertain' },
        durationMs: Math.round(performance.now() - started)
      };
    }

    try {
      const endpoint = await this.#launcher.ensureEndpoint();
      if (endpoint !== this.#endpoint) {
        await this.#delegate.close?.();
        this.#endpoint = endpoint;
        this.#delegate = new BrowserCdpProvider(endpoint);
      }
      const retried = await this.#delegate.execute(action, context);
      return {
        ...retried,
        provider: this.name,
        evidence: [
          evidence('browser_lifecycle', retried.ok ? 'pass' : 'fail', retried.ok ? 'A local Chromium endpoint was recovered or discovered and the browser action was retried.' : 'A local Chromium endpoint was recovered or discovered but the browser action still failed.', { endpoint }),
          ...retried.evidence
        ],
        durationMs: Math.round(performance.now() - started)
      };
    } catch (error) {
      const op = error instanceof OperatorError ? error : new OperatorError('BROWSER_LAUNCH_FAILED', error instanceof Error ? error.message : String(error), { retryable: true });
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [...first.evidence, evidence('browser_lifecycle', 'fail', op.message, { code: op.code })],
        error: { code: op.code, message: op.message, retryable: op.retryable },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }

  async reconcile(
    request: ProviderReconciliationRequest,
    context: CapabilityExecutionContext = {}
  ): Promise<ProviderReconciliationResult> {
    if (!this.#delegate.reconcile) {
      return {
        status: 'uncertain',
        evidence: [evidence('browser_reconciliation', 'info', 'Managed browser delegate does not implement reconciliation.')]
      };
    }
    const outcome = await this.#delegate.reconcile(request, context);
    return {
      ...outcome,
      ...(outcome.result ? { result: { ...outcome.result, provider: this.name } } : {}),
      evidence: outcome.evidence
    };
  }

  async emergencyStop(): Promise<void> {
    await this.#closeOwnedResources();
  }

  async close(): Promise<void> {
    await this.#closeOwnedResources();
  }

  async #closeOwnedResources(): Promise<void> {
    if (this.#dedicatedProfileOnly && this.#dedicatedBindInFlight) {
      await this.#dedicatedBindInFlight.catch(() => undefined);
    }
    const results = await Promise.allSettled([
      (async () => this.#delegate.close?.())(),
      (async () => this.#launcher.close())()
    ]);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) throw rejected.reason;
  }
}

async function terminateManagedChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
    await new Promise<void>((resolve, reject) => {
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
        shell: false, windowsHide: true, stdio: 'ignore', env: safeChildEnvironment('windows-native')
      });
      killer.once('error', reject);
      killer.once('close', () => resolve());
    });
  } else {
    try { child.kill('SIGTERM'); } catch { /* postcondition below decides */ }
  }
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch { /* postcondition below decides */ }
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
  }
  if (child.exitCode === null && child.signalCode === null) throw new OperatorError('BROWSER_TERMINATE_POSTCONDITION_FAILED', 'Managed browser remained alive after shutdown.', { retryable: false });
}
