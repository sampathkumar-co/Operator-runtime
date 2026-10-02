import crypto from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import type { ActionRequest, ActionResult, CapabilityExecutionContext, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { safeChildEnvironment } from '../core/child-environment.ts';

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
const PHYSICAL_INPUT_OPERATIONS = ['move', 'click', 'double_click', 'drag', 'scroll', 'type_text', 'key_press', 'hotkey'] as const;
const CAPTURE_LEASE_MS = 90_000;
const MAX_CAPTURE_LEASES = 32;
const AFTER_CAPTURE_SETTLE_MS = 200;
const SCROLL_AMOUNTS = ['large_decrement', 'small_decrement', 'none', 'large_increment', 'small_increment'] as const;

type SidecarError = { code: string; message: string; retryable?: boolean };
type SidecarResponse = { id: string; ok: boolean; result?: unknown; error?: SidecarError };
type CaptureLease = {
  captureId: string;
  sha256: string;
  createdAt: number;
  expiresAt: number;
  originX: number;
  originY: number;
  sourceWidth: number;
  sourceHeight: number;
  returnedWidth: number;
  returnedHeight: number;
  scaleX: number;
  scaleY: number;
  captureParams: Record<string, unknown>;
  windowId?: string;
};

type Pending = {
  resolve: (response: SidecarResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cleanup?: () => void;
};

export type WindowsUiaOptions = {
  binaryPath?: string;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  client?: { call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>; close(): void };
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

  async call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new OperatorError('EXECUTION_ABORTED', 'Windows UIA execution was cancelled.', { retryable: false });
    await this.#ensureStarted();
    if (signal?.aborted) throw new OperatorError('EXECUTION_ABORTED', 'Windows UIA execution was cancelled.', { retryable: false });
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
      let cleanupAbort = () => {};
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        cleanupAbort();
        reject(new OperatorError('UIA_SIDECAR_TIMEOUT', `${method} timed out.`, { retryable: true }));
      }, this.#timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.#pending.delete(id);
        cleanupAbort();
        reject(new OperatorError('EXECUTION_ABORTED', 'Windows UIA execution was cancelled.', { retryable: false }));
        this.close();
      };
      cleanupAbort = () => signal?.removeEventListener('abort', onAbort);
      this.#pending.set(id, { resolve, reject, timer, cleanup: cleanupAbort });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        cleanupAbort();
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
      pending.cleanup?.();
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
      windowsHide: true,
      env: safeChildEnvironment('windows-native')
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
      pending.cleanup?.();
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
        pending.cleanup?.();
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
  #client: { call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>; close(): void };
  #captureLeases = new Map<string, CaptureLease>();

  constructor(options: WindowsUiaOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    const binary = options.binaryPath
      ?? process.env.OPERATOR_WINDOWS_UIA_PATH
      ?? path.join(process.cwd(), 'native', 'windows-uia', 'target', 'release', 'operator-windows-uia.exe');
    this.#client = options.client ?? new WindowsUiaSidecarClient(binary, options.timeoutMs);
  }

  supports(action: ActionRequest): boolean {
    return this.#platform === 'win32' && ['app.inspect', 'app.operate', 'visual.capture', 'input.operate'].includes(action.capability);
  }

  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest, context: CapabilityExecutionContext = {}): Promise<ActionResult> {
    const started = performance.now();
    try {
      const output = action.capability === 'app.inspect'
        ? await this.#client.call('inspect', normalizeInspectInput(action.input), context.signal)
        : action.capability === 'app.operate'
          ? await this.#client.call('operate', normalizeOperateInput(action.input), context.signal)
          : action.capability === 'visual.capture'
            ? await this.#capture(action, context.signal)
            : await this.#physicalInput(action, context.signal);
      const postcondition = action.capability === 'app.operate'
        ? evidence('postcondition', 'pass', 'Windows UIA/Win32 operation returned verified semantic postcondition evidence.', { operation: action.input.operation, waitMs: normalizeWaitMs(action.input.waitMs) })
        : action.capability === 'visual.capture'
          ? evidence('visual_observation', 'pass', 'Captured bounded visual state with a short-lived SHA-bound interaction lease.', {
              captureId: asRecord(output).captureId,
              sha256: asRecord(output).sha256,
              expiresAt: asRecord(output).expiresAt,
              source: asRecord(output).source
            })
          : action.capability === 'input.operate'
            ? evidence('physical_input', 'pass', 'Physical input was dispatched only after validating a fresh capture lease and target geometry.', {
                operation: action.input.operation,
                captureId: action.input.captureId
              })
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
          evidence('windows_uia', 'pass', action.capability === 'app.inspect' ? 'Inspected Windows controls through Microsoft UI Automation and optional bounded Win32 discovery.' : action.capability === 'visual.capture' ? 'Captured bounded Windows visual state through the signed native sidecar.' : action.capability === 'input.operate' ? 'Dispatched capture-bound physical input through the signed native sidecar.' : 'Operated Windows control through a verified UI Automation or semantic Win32 operation.', {}),
          postcondition
        ],
        durationMs: Math.round(performance.now() - started)
      };
    } catch (error) {
      const op = error instanceof OperatorError
        ? error
        : new OperatorError('UIA_PROVIDER_FAILED', error instanceof Error ? error.message : String(error), { retryable: true });
      const ambiguousMutation = action.risk !== 'read'
        && ['UIA_SIDECAR_TIMEOUT', 'UIA_SIDECAR_CLOSED', 'UIA_SIDECAR_EXITED', 'EXECUTION_ABORTED'].includes(op.code);
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [evidence('windows_uia', 'fail', op.message, { code: op.code })],
        error: { code: op.code, message: op.message, retryable: ambiguousMutation ? false : op.retryable, sideEffectState: ambiguousMutation ? 'uncertain' : action.risk === 'read' ? 'none' : undefined },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }

  async #capture(action: ActionRequest, signal?: AbortSignal): Promise<unknown> {
    this.#pruneCaptureLeases();
    const captureParams = normalizeVisualCaptureInput(action.input);
    const raw = asRecord(await this.#client.call('capture', captureParams, signal));
    const pngBase64 = String(raw.png_base64 ?? '');
    const png = Buffer.from(pngBase64, 'base64');
    if (png.length < 16 || png.length > 8 * 1024 * 1024) throw new OperatorError('VISUAL_CAPTURE_INVALID', 'Native capture returned an invalid PNG payload.');
    const sha256 = crypto.createHash('sha256').update(png).digest('hex');
    const captureId = crypto.randomUUID();
    const now = Date.now();
    const lease: CaptureLease = {
      captureId, sha256, createdAt: now, expiresAt: now + CAPTURE_LEASE_MS,
      originX: boundedCaptureInteger(raw.origin_x, -100_000, 100_000, 'origin_x'),
      originY: boundedCaptureInteger(raw.origin_y, -100_000, 100_000, 'origin_y'),
      sourceWidth: boundedCaptureInteger(raw.source_width, 1, 100_000, 'source_width'),
      sourceHeight: boundedCaptureInteger(raw.source_height, 1, 100_000, 'source_height'),
      returnedWidth: boundedCaptureInteger(raw.returned_width, 1, 1280, 'returned_width'),
      returnedHeight: boundedCaptureInteger(raw.returned_height, 1, 720, 'returned_height'),
      scaleX: boundedCaptureNumber(raw.scale_x, 0.0001, 1000, 'scale_x'),
      scaleY: boundedCaptureNumber(raw.scale_y, 0.0001, 1000, 'scale_y'),
      captureParams: structuredClone(captureParams),
      ...(typeof raw.window_id === 'string' && raw.window_id ? { windowId: raw.window_id } : {})
    };
    this.#captureLeases.set(captureId, lease);
    while (this.#captureLeases.size > MAX_CAPTURE_LEASES) {
      const oldest = this.#captureLeases.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#captureLeases.delete(oldest);
    }
    return {
      captureId,
      sha256,
      expiresAt: new Date(lease.expiresAt).toISOString(),
      source: raw.source,
      originX: lease.originX,
      originY: lease.originY,
      sourceWidth: lease.sourceWidth,
      sourceHeight: lease.sourceHeight,
      width: lease.returnedWidth,
      height: lease.returnedHeight,
      scaleX: lease.scaleX,
      scaleY: lease.scaleY,
      ...(lease.windowId ? { windowId: lease.windowId } : {}),
      mimeType: 'image/png',
      imageBase64: pngBase64
    };
  }

  async #physicalInput(action: ActionRequest, signal?: AbortSignal): Promise<unknown> {
    this.#pruneCaptureLeases();
    const captureId = requiredCaptureText(action.input.captureId, 'captureId', 128);
    const expectedSha256 = requiredCaptureText(action.input.expectedSha256, 'expectedSha256', 64).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new OperatorError('INPUT_CAPTURE_INVALID', 'expectedSha256 must be a SHA-256 digest.');
    const lease = this.#captureLeases.get(captureId);
    if (!lease || lease.expiresAt <= Date.now()) {
      this.#captureLeases.delete(captureId);
      throw new OperatorError('INPUT_CAPTURE_STALE', 'Visual capture lease expired; capture fresh state before physical input.', { retryable: true });
    }
    if (lease.sha256 !== expectedSha256) throw new OperatorError('INPUT_CAPTURE_MISMATCH', 'Physical input capture hash does not match the leased visual state.', { retryable: false });
    const operation = String(action.input.operation ?? '');
    if (!(PHYSICAL_INPUT_OPERATIONS as readonly string[]).includes(operation)) throw new OperatorError('INPUT_OPERATION_INVALID', 'Physical input operation is outside the closed operation set.');
    const params: Record<string, unknown> = {
      operation,
      ...(lease.windowId ? { expected_window_id: lease.windowId } : {})
    };
    if (['move', 'click', 'double_click', 'drag', 'scroll'].includes(operation)) {
      const point = capturePointToScreen(action.input.x, action.input.y, lease);
      params.x = point.x; params.y = point.y;
    }
    if (operation === 'drag') {
      const point = capturePointToScreen(action.input.toX, action.input.toY, lease);
      params.to_x = point.x; params.to_y = point.y;
    }
    if (operation === 'scroll') {
      params.delta_x = boundedCaptureInteger(action.input.deltaX ?? 0, -1200, 1200, 'deltaX');
      params.delta_y = boundedCaptureInteger(action.input.deltaY ?? 0, -1200, 1200, 'deltaY');
    }
    if (operation === 'type_text') params.text = requiredCaptureText(action.input.text, 'text', 4096);
    if (operation === 'key_press') params.key = requiredCaptureText(action.input.key, 'key', 32);
    if (operation === 'hotkey') {
      if (!Array.isArray(action.input.keys) || action.input.keys.length < 1 || action.input.keys.length > 4) throw new OperatorError('INPUT_KEYS_INVALID', 'hotkey keys must contain 1-4 entries.');
      params.keys = action.input.keys.map((value, index) => requiredCaptureText(value, `keys[${index}]`, 32));
    }
    // Re-observe immediately before dispatch. The caller's hash proves which
    // capture it reasoned over; this fresh hash proves that capture is still current.
    let currentRaw: Record<string, unknown>;
    try {
      currentRaw = asRecord(await this.#client.call('capture', lease.captureParams, signal));
    } catch (error) {
      this.#captureLeases.delete(captureId);
      throw new OperatorError('INPUT_CAPTURE_REVALIDATION_FAILED', `Could not revalidate the visual capture before physical input: ${error instanceof Error ? error.message : String(error)}`, { retryable: true });
    }
    const currentBase64 = String(currentRaw.png_base64 ?? '');
    const currentPng = Buffer.from(currentBase64, 'base64');
    if (currentPng.length < 16 || currentPng.length > 8 * 1024 * 1024) {
      this.#captureLeases.delete(captureId);
      throw new OperatorError('INPUT_CAPTURE_INVALID', 'Fresh pre-input capture returned an invalid PNG payload.', { retryable: true });
    }
    const currentSha256 = crypto.createHash('sha256').update(currentPng).digest('hex');
    const currentWindowId = typeof currentRaw.window_id === 'string' ? currentRaw.window_id : undefined;
    if (currentSha256 !== lease.sha256 || (lease.windowId && currentWindowId !== lease.windowId)) {
      this.#captureLeases.delete(captureId);
      throw new OperatorError('INPUT_CAPTURE_STALE', 'Visual state changed after reasoning; capture fresh state before physical input.', { retryable: true });
    }

    const before = {
      captureId,
      sha256: lease.sha256,
      revalidatedSha256: currentSha256,
      expiresAt: new Date(lease.expiresAt).toISOString(),
      ...(lease.windowId ? { windowId: lease.windowId } : {})
    };
    const native = asRecord(await this.#client.call('input', params, signal));
    // A physical action consumes its BEFORE lease regardless of verification outcome.
    this.#captureLeases.delete(captureId);
    await waitForVisualSettle(AFTER_CAPTURE_SETTLE_MS, signal);

    let afterRaw: Record<string, unknown>;
    try {
      afterRaw = asRecord(await this.#client.call('capture', lease.captureParams, signal));
    } catch (error) {
      throw new OperatorError(
        'INPUT_AFTER_CAPTURE_FAILED',
        `Physical input was dispatched but AFTER capture verification failed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: false }
      );
    }
    const afterBase64 = String(afterRaw.png_base64 ?? '');
    const afterPng = Buffer.from(afterBase64, 'base64');
    if (afterPng.length < 16 || afterPng.length > 8 * 1024 * 1024) {
      throw new OperatorError('INPUT_AFTER_CAPTURE_INVALID', 'Physical input was dispatched but AFTER capture returned an invalid PNG payload.', { retryable: false });
    }
    const afterSha256 = crypto.createHash('sha256').update(afterPng).digest('hex');
    const after = {
      sha256: afterSha256,
      changed: afterSha256 !== lease.sha256,
      source: afterRaw.source,
      originX: boundedCaptureInteger(afterRaw.origin_x, -100_000, 100_000, 'after.origin_x'),
      originY: boundedCaptureInteger(afterRaw.origin_y, -100_000, 100_000, 'after.origin_y'),
      sourceWidth: boundedCaptureInteger(afterRaw.source_width, 1, 100_000, 'after.source_width'),
      sourceHeight: boundedCaptureInteger(afterRaw.source_height, 1, 100_000, 'after.source_height'),
      width: boundedCaptureInteger(afterRaw.returned_width, 1, 1280, 'after.returned_width'),
      height: boundedCaptureInteger(afterRaw.returned_height, 1, 720, 'after.returned_height'),
      ...(typeof afterRaw.window_id === 'string' && afterRaw.window_id ? { windowId: afterRaw.window_id } : {}),
      mimeType: 'image/png',
      imageBase64: afterBase64
    };
    if (lease.windowId && after.windowId !== lease.windowId) {
      throw new OperatorError('INPUT_AFTER_WINDOW_CHANGED', 'Physical input was dispatched but AFTER capture resolved to a different window.', { retryable: false });
    }
    return {
      operation,
      before,
      native,
      after,
      postcondition: {
        dispatched: true,
        captureLeaseConsumed: true,
        afterCaptured: true,
        afterSha256,
        changed: after.changed,
        windowStable: lease.windowId ? after.windowId === lease.windowId : true
      }
    };
  }

  #pruneCaptureLeases(): void {
    const now = Date.now();
    for (const [captureId, lease] of this.#captureLeases) if (lease.expiresAt <= now) this.#captureLeases.delete(captureId);
  }

  close(): void {
    this.#captureLeases.clear();
    this.#client.close();
  }
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


function normalizeVisualCaptureInput(input: Record<string, unknown>): Record<string, unknown> {
  const source = ['screen', 'window', 'region'].includes(String(input.source ?? 'screen')) ? String(input.source ?? 'screen') : 'screen';
  const output: Record<string, unknown> = {
    source,
    max_width: boundedCaptureInteger(input.maxWidth ?? 960, 1, 1280, 'maxWidth'),
    max_height: boundedCaptureInteger(input.maxHeight ?? 540, 1, 720, 'maxHeight'),
    wait_ms: boundedCaptureInteger(input.waitMs ?? 0, 0, 10_000, 'waitMs')
  };
  if (source === 'window') output.selector = normalizeSelector(input.selector);
  if (source === 'region') {
    const region = asRecord(input.region);
    output.region = {
      x: boundedCaptureInteger(region.x, -100_000, 100_000, 'region.x'),
      y: boundedCaptureInteger(region.y, -100_000, 100_000, 'region.y'),
      width: boundedCaptureInteger(region.width, 1, 16_384, 'region.width'),
      height: boundedCaptureInteger(region.height, 1, 16_384, 'region.height')
    };
  }
  return output;
}

function capturePointToScreen(xValue: unknown, yValue: unknown, lease: CaptureLease): { x: number; y: number } {
  const x = boundedCaptureInteger(xValue, 0, lease.returnedWidth - 1, 'x');
  const y = boundedCaptureInteger(yValue, 0, lease.returnedHeight - 1, 'y');
  const screenX = lease.originX + Math.round(x * lease.scaleX);
  const screenY = lease.originY + Math.round(y * lease.scaleY);
  if (screenX < lease.originX || screenY < lease.originY || screenX >= lease.originX + lease.sourceWidth || screenY >= lease.originY + lease.sourceHeight) {
    throw new OperatorError('INPUT_POINT_OUTSIDE_CAPTURE', 'Mapped input point falls outside the leased visual capture.');
  }
  return { x: screenX, y: screenY };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedCaptureInteger(value: unknown, min: number, max: number, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new OperatorError('VISUAL_INPUT_INVALID', `${label} must be an integer from ${min} to ${max}.`);
  return parsed;
}

function boundedCaptureNumber(value: unknown, min: number, max: number, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new OperatorError('VISUAL_CAPTURE_INVALID', `${label} is outside the allowed range.`);
  return parsed;
}

function requiredCaptureText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new OperatorError('VISUAL_INPUT_INVALID', `${label} is invalid.`);
  return value;
}


async function waitForVisualSettle(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new OperatorError('EXECUTION_ABORTED', 'Physical input verification was cancelled.', { retryable: false });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new OperatorError('EXECUTION_ABORTED', 'Physical input verification was cancelled.', { retryable: false }));
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
