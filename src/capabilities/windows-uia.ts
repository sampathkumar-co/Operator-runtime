import crypto from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';

const SCORE: CapabilityScore = {
  reliability: 0.95,
  latency: 0.91,
  determinism: 0.98,
  security: 0.97,
  reversibility: 0.88,
  informationQuality: 0.98,
  interactionCost: 0.01
};

const MAX_RESPONSE_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OBSERVE_MS = 5_000;
const MAX_WAIT_MS = 10_000;
const DEFAULT_MAX_WINDOWS = 50;
const MAX_WINDOWS = 200;
const UIA_OPERATIONS = ['invoke', 'set_value', 'focus', 'select', 'expand', 'collapse', 'scroll', 'activate_window'] as const;
const SCROLL_AMOUNTS = ['large_decrement', 'small_decrement', 'none', 'large_increment', 'small_increment'] as const;

type SidecarError = { code: string; message: string; retryable?: boolean };
type SidecarResponse = { id: string; ok: boolean; result?: unknown; error?: SidecarError };
type Pending = {
  resolve: (response: SidecarResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type WindowsUiaOptions = {
  binaryPath?: string;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
};

class WindowsUiaSidecarClient {
  #binaryPath: string;
  #timeoutMs: number;
  #process?: ChildProcessWithoutNullStreams;
  #pending = new Map<string, Pending>();
  #starting?: Promise<void>;
  #stderrTail: string[] = [];

  constructor(binaryPath: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.#binaryPath = path.resolve(binaryPath);
    this.#timeoutMs = Math.min(Math.max(timeoutMs, 1_000), 120_000);
  }

  async call(method: string, params: unknown): Promise<unknown> {
    await this.#ensureStarted();
    const child = this.#process;
    if (!child || child.exitCode !== null || child.stdin.destroyed) {
      throw new OperatorError('UIA_SIDECAR_UNAVAILABLE', 'Windows UIA sidecar is not running.', { retryable: true });
    }

    const id = crypto.randomUUID();
    const payload = JSON.stringify({ id, method, params });
    if (Buffer.byteLength(payload) > 256 * 1024) {
      throw new OperatorError('UIA_REQUEST_TOO_LARGE', 'Windows UIA request exceeds 256 KiB.');
    }

    const response = await new Promise<SidecarResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new OperatorError('UIA_SIDECAR_TIMEOUT', `${method} timed out.`, { retryable: true }));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new OperatorError('UIA_SIDECAR_WRITE_FAILED', error.message, { retryable: true }));
      });
    });

    if (!response.ok) {
      throw new OperatorError(
        response.error?.code ?? 'UIA_OPERATION_FAILED',
        response.error?.message ?? 'Windows UIA operation failed.',
        { retryable: response.error?.retryable === true }
      );
    }
    return response.result;
  }

  close(): void {
    const child = this.#process;
    this.#process = undefined;
    this.#starting = undefined;
    const error = new OperatorError('UIA_SIDECAR_CLOSED', 'Windows UIA sidecar closed.', { retryable: true });
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill('SIGTERM'); } catch { /* noop */ }
    }
  }

  async #ensureStarted(): Promise<void> {
    if (this.#process && this.#process.exitCode === null) return;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start();
    try { await this.#starting; } finally { this.#starting = undefined; }
  }

  async #start(): Promise<void> {
    const child = spawn(this.#binaryPath, [], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.#process = child;

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        this.#stderrTail.push(line.slice(0, 1000));
        if (this.#stderrTail.length > 20) this.#stderrTail.shift();
      }
    });

    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (Buffer.byteLength(line) > MAX_RESPONSE_LINE_BYTES) {
        this.close();
        return;
      }
      let response: SidecarResponse;
      try { response = JSON.parse(line) as SidecarResponse; } catch { return; }
      if (!response?.id) return;
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(response.id);
      pending.resolve(response);
    });

    child.once('exit', (code, signal) => {
      if (this.#process === child) this.#process = undefined;
      const details = this.#stderrTail.slice(-5).join(' | ');
      const error = new OperatorError(
        'UIA_SIDECAR_EXITED',
        `Windows UIA sidecar exited (${code ?? signal ?? 'unknown'}).${details ? ` ${details}` : ''}`,
        { retryable: true }
      );
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new OperatorError('UIA_SIDECAR_START_TIMEOUT', 'Windows UIA sidecar did not become ready.', { retryable: true })), 5_000);
      child.once('spawn', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(new OperatorError('UIA_SIDECAR_START_FAILED', error.message, { retryable: false }));
      });
    });

    try {
      await this.call('health', {});
    } catch (error) {
      this.close();
      throw error;
    }
  }
}

export class WindowsUiaProvider implements CapabilityProvider {
  readonly name = 'windows.uia';
  #platform: NodeJS.Platform;
  #client: WindowsUiaSidecarClient;

  constructor(options: WindowsUiaOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    const binary = options.binaryPath
      ?? process.env.OPERATOR_WINDOWS_UIA_PATH
      ?? path.join(process.cwd(), 'native', 'windows-uia', 'target', 'release', 'operator-windows-uia.exe');
    this.#client = new WindowsUiaSidecarClient(binary, options.timeoutMs);
  }

  supports(action: ActionRequest): boolean {
    return this.#platform === 'win32' && ['app.inspect', 'app.operate'].includes(action.capability);
  }

  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const started = performance.now();
    try {
      const output = action.capability === 'app.inspect'
        ? await this.#client.call('inspect', normalizeInspectInput(action.input))
        : await this.#client.call('operate', normalizeOperateInput(action.input));
      const postcondition = action.capability === 'app.operate'
        ? evidence('postcondition', 'pass', 'Windows UIA/Win32 operation returned verified semantic postcondition evidence.', { operation: action.input.operation, waitMs: normalizeWaitMs(action.input.waitMs) })
        : evidence('data_minimization', 'pass', 'Windows UIA returned a bounded semantic control tree, optional scoped events, and opt-in top-level window metadata instead of screenshots or process internals.', {
            observeMs: normalizeObserveMs(action.input.observeMs),
            waitMs: normalizeWaitMs(action.input.waitMs),
            includeWindows: action.input.includeWindows === true,
            maxWindows: normalizeMaxWindows(action.input.maxWindows)
          });
      return {
        ok: true,
        capability: action.capability,
        provider: this.name,
        output,
        evidence: [
          evidence('windows_uia', 'pass', action.capability === 'app.inspect' ? 'Inspected Windows controls through Microsoft UI Automation and optional bounded Win32 discovery.' : 'Operated Windows control through a verified UI Automation or semantic Win32 operation.', {}),
          postcondition
        ],
        durationMs: Math.round(performance.now() - started)
      };
    } catch (error) {
      const op = error instanceof OperatorError
        ? error
        : new OperatorError('UIA_PROVIDER_FAILED', error instanceof Error ? error.message : String(error), { retryable: true });
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [evidence('windows_uia', 'fail', op.message, { code: op.code })],
        error: { code: op.code, message: op.message, retryable: op.retryable },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }

  close(): void { this.#client.close(); }
}

function normalizeSelector(input: unknown) {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const text = (key: string) => typeof raw[key] === 'string' ? String(raw[key]).trim().slice(0, 512) || undefined : undefined;
  const processId = Number.isInteger(raw.processId) && Number(raw.processId) > 0 ? Number(raw.processId) : undefined;
  return {
    name: text('name'),
    automation_id: text('automationId'),
    class_name: text('className'),
    control_type: text('controlType'),
    process_id: processId
  };
}

function normalizeObserveMs(value: unknown): number {
  return Number.isInteger(value) ? Math.min(Math.max(Number(value), 0), MAX_OBSERVE_MS) : 0;
}

function normalizeWaitMs(value: unknown): number {
  return Number.isInteger(value) ? Math.min(Math.max(Number(value), 0), MAX_WAIT_MS) : 0;
}

function normalizeMaxWindows(value: unknown): number {
  return Number.isInteger(value) ? Math.min(Math.max(Number(value), 1), MAX_WINDOWS) : DEFAULT_MAX_WINDOWS;
}

function normalizeInspectInput(input: Record<string, unknown>) {
  return {
    selector: input.selector ? normalizeSelector(input.selector) : undefined,
    max_nodes: Number.isInteger(input.maxNodes) ? Number(input.maxNodes) : undefined,
    max_depth: Number.isInteger(input.maxDepth) ? Number(input.maxDepth) : undefined,
    observe_ms: normalizeObserveMs(input.observeMs),
    wait_ms: normalizeWaitMs(input.waitMs),
    include_windows: input.includeWindows === true,
    max_windows: normalizeMaxWindows(input.maxWindows)
  };
}

function normalizeScrollAmount(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(SCROLL_AMOUNTS as readonly string[]).includes(value)) {
    throw new OperatorError('INVALID_UIA_SCROLL_AMOUNT', `${field} must be one of ${SCROLL_AMOUNTS.join(', ')}.`);
  }
  return value;
}

function normalizeOperateInput(input: Record<string, unknown>) {
  const operation = String(input.operation ?? '');
  if (!(UIA_OPERATIONS as readonly string[]).includes(operation)) {
    throw new OperatorError('INVALID_UIA_OPERATION', `operation must be ${UIA_OPERATIONS.join(', ')}.`);
  }
  const horizontalAmount = normalizeScrollAmount(input.horizontalAmount, 'horizontalAmount');
  const verticalAmount = normalizeScrollAmount(input.verticalAmount, 'verticalAmount');
  if (operation === 'scroll' && horizontalAmount === undefined && verticalAmount === undefined) {
    throw new OperatorError('INVALID_UIA_SCROLL_AMOUNT', 'scroll requires horizontalAmount or verticalAmount.');
  }
  return {
    operation,
    selector: normalizeSelector(input.selector),
    value: input.value === undefined ? undefined : String(input.value),
    horizontal_amount: horizontalAmount,
    vertical_amount: verticalAmount,
    wait_ms: normalizeWaitMs(input.waitMs)
  };
}
