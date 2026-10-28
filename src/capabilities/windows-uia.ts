import crypto from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import type { ActionRequest, ActionResult, CapabilityExecutionContext, CapabilityProvider, CapabilityScore, ProviderReconciliationRequest, ProviderReconciliationResult } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import type { ArtifactStore } from '../core/artifact-store.ts';
import { OperatorError } from '../core/errors.ts';
import { reconcileFromDurableResult } from '../core/reconciliation-coverage.ts';
import { safeChildEnvironment } from '../core/child-environment.ts';
import { createRenderedDeltaEvidence, createRenderedEvidence, type RenderedEvidence, type RenderedEvidenceTier } from '../core/rendered-evidence.ts';

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

/** Physical input operation identity cannot originate from JS string coercion. */
export function strictPhysicalInputOperation(value: unknown): typeof PHYSICAL_INPUT_OPERATIONS[number] {
  if (typeof value !== 'string' || !(PHYSICAL_INPUT_OPERATIONS as readonly string[]).includes(value)) {
    throw new OperatorError('INPUT_OPERATION_INVALID', 'Physical input operation is outside the closed operation set.');
  }
  return value as typeof PHYSICAL_INPUT_OPERATIONS[number];
}

/** Native capture protocol fields are strings, not attacker-coercible arrays/objects. */
export function strictNativeInputResult(
  value: unknown, operation: string, windowBound: boolean
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperatorError('INPUT_NATIVE_RESULT_INVALID',
      'Native Windows input returned an invalid dispatched action receipt.');
  }
  const record = value as Record<string, unknown>;
  const state = record.postcondition;
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      record.operation !== operation ||
      (state as Record<string, unknown>).dispatched !== true ||
      (state as Record<string, unknown>).foreground !== windowBound) {
    throw new OperatorError('INPUT_NATIVE_RESULT_INVALID',
      'Native Windows input did not confirm the exact dispatched operation and window scope.');
  }
  return record;
}

export function strictNativeCaptureBase64(value: unknown, phase: 'initial' | 'before_input' | 'after_input'): string {
  const code = phase === 'initial' ? 'VISUAL_CAPTURE_INVALID'
    : phase === 'before_input' ? 'INPUT_CAPTURE_INVALID' : 'INPUT_AFTER_CAPTURE_INVALID';
  // Native helper responses are bounded to 4 MiB; also bound this field
  // independently in case an injected client bypasses the native transport.
  if (typeof value !== 'string' || value.length < 24 || value.length > 4 * 1024 * 1024) {
    throw new OperatorError(code, 'Native screenshot payload must be a bounded literal base64 string.');
  }
  return value;
}
// Only runtime-defined or vetted native protocol error codes may cross the
 // public boundary. A regex allows native/page-owned secret text in an error code.
const PUBLIC_UIA_ERROR_CODES = new Set([
  'UNSUPPORTED_ACTION', 'EXECUTION_ABORTED', 'UIA_PROVIDER_FAILED', 'UIA_OPERATION_FAILED',
  'UIA_SIDECAR_CLOSED', 'UIA_SIDECAR_EXITED', 'UIA_SIDECAR_TIMEOUT',
  'UIA_SIDECAR_UNAVAILABLE', 'UIA_SIDECAR_WRITE_FAILED',
  'UIA_SIDECAR_START_FAILED', 'UIA_SIDECAR_START_TIMEOUT',
  'UIA_SIDECAR_PROTOCOL_INVALID',
  'UIA_OPERATION_IDENTITY_INVALID',
  'UIA_SIDECAR_TERMINATE_FAILED', 'UIA_REQUEST_TOO_LARGE',
  'INVALID_UIA_OPERATION', 'INVALID_UIA_SCROLL_AMOUNT',
  'INVALID_UIA_SELECTOR', 'INVALID_UIA_VALUE', 'INVALID_UIA_INSPECT_LIMIT',
  'INPUT_AFTER_CAPTURE_INVALID', 'INPUT_AFTER_CAPTURE_FAILED',
  'INPUT_AFTER_WINDOW_CHANGED', 'INPUT_AFTER_SOURCE_CHANGED', 'INPUT_CAPTURE_INVALID',
  'INPUT_CAPTURE_MISMATCH', 'INPUT_CAPTURE_REVALIDATION_FAILED',
  'INPUT_CAPTURE_STALE', 'INPUT_KEYS_INVALID',
  'INPUT_OPERATION_INVALID', 'INPUT_POINT_OUTSIDE_CAPTURE',
  'VISUAL_CAPTURE_INVALID', 'VISUAL_CAPTURE_ARTIFACT_REQUIRED', 'VISUAL_INPUT_INVALID',
  'INPUT_NATIVE_RESULT_INVALID'
]);
const UNCERTAIN_UIA_MUTATION_ERRORS = new Set([
  'UIA_SIDECAR_TIMEOUT', 'UIA_SIDECAR_CLOSED', 'UIA_SIDECAR_EXITED',
  'UIA_SIDECAR_WRITE_FAILED', 'EXECUTION_ABORTED', 'UIA_OPERATION_FAILED',
  'UIA_SIDECAR_PROTOCOL_INVALID',
  'UIA_OPERATION_IDENTITY_INVALID',
  'INPUT_AFTER_CAPTURE_FAILED', 'INPUT_AFTER_CAPTURE_INVALID',
  'INPUT_AFTER_WINDOW_CHANGED', 'INPUT_AFTER_SOURCE_CHANGED',
  'VISUAL_CAPTURE_ARTIFACT_REQUIRED', 'INPUT_NATIVE_RESULT_INVALID', 'UIA_PROVIDER_FAILED'
]);
const CAPTURE_LEASE_MS = 90_000;
const MAX_INLINE_VISUAL_BYTES = 96 * 1024;
const MAX_CAPTURE_LEASES = 32;
const AFTER_CAPTURE_SETTLE_MS = 200;
const SCROLL_AMOUNTS = ['large_decrement', 'small_decrement', 'none', 'large_increment', 'small_increment'] as const;

type SidecarError = { code: string; message: string; retryable?: boolean };
type SidecarResponse = { id: string; ok: boolean; result?: unknown; error?: SidecarError };

/** Native JSON is untrusted until its boolean result is validated at runtime. */
export function strictUiaSidecarOutcome(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new OperatorError('UIA_SIDECAR_PROTOCOL_INVALID',
      'Native UIA response did not contain a boolean success flag.', { retryable: false });
  }
  return value;
}

/** Bind a mutating native receipt back to the selected process/control/window.
 * The sidecar is a protocol boundary, so a claimed postcondition cannot switch
 * identities between its before and after observations. */
export function strictUiaOperationIdentity(
  value: unknown,
  expected: { operation: string; selector: Record<string, unknown> }
): void {
  const fail = (): never => { throw new OperatorError('UIA_OPERATION_IDENTITY_INVALID',
    'Native UIA operation receipt did not preserve the selected target identity.', { retryable: false }); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const receipt = value as Record<string, unknown>;
  if (receipt.operation !== expected.operation) fail();
  const before = receipt.before;
  const after = receipt.after;
  if (!before || typeof before !== 'object' || Array.isArray(before) ||
      !after || typeof after !== 'object' || Array.isArray(after)) fail();
  const left = before as Record<string, unknown>;
  const right = after as Record<string, unknown>;
  const processId = expected.selector.process_id;
  if (!Number.isSafeInteger(left.process_id) || Number(left.process_id) <= 0 ||
      left.process_id !== right.process_id ||
      (processId !== undefined && left.process_id !== processId)) fail();
  const automationId = expected.selector.automation_id;
  // activate_window returns a Win32 window receipt after resolving the UIA
  // selector; that receipt preserves process/window but has no control id.
  if (expected.operation !== 'activate_window' && automationId !== undefined &&
      (left.automation_id !== automationId || right.automation_id !== automationId)) fail();
  const leftWindow = left.window_id;
  const rightWindow = right.window_id;
  if ((leftWindow !== undefined || rightWindow !== undefined) &&
      (typeof leftWindow !== 'string' || typeof rightWindow !== 'string' ||
       !leftWindow || leftWindow.toLowerCase() !== rightWindow.toLowerCase())) fail();
}

const REQUIRED_UIA_SIDECAR_CAPABILITIES = [
  'inspect', 'visual_capture', 'physical_input'
] as const;

/** Validate the native helper identity and protocol before dispatching work. */
export function strictUiaSidecarHealth(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperatorError('UIA_SIDECAR_PROTOCOL_INVALID',
      'Native UIA health response was not an object.', { retryable: false });
  }
  const health = value as Record<string, unknown>;
  const capabilities = health.capabilities;
  const validCapabilities = Array.isArray(capabilities)
    && capabilities.length >= REQUIRED_UIA_SIDECAR_CAPABILITIES.length
    && capabilities.length <= 64
    && capabilities.every((item) => typeof item === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(item))
    && new Set(capabilities).size === capabilities.length
    && REQUIRED_UIA_SIDECAR_CAPABILITIES.every((item) => capabilities.includes(item));
  if (health.service !== 'operator-windows-uia'
      || health.protocol !== 1
      || typeof health.version !== 'string'
      || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(health.version)
      || typeof health.uia_available !== 'boolean'
      || !validCapabilities) {
    throw new OperatorError('UIA_SIDECAR_PROTOCOL_INVALID',
      'Native UIA helper identity, protocol, or capability declaration was invalid.', { retryable: false });
  }
}

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
  sceneKey: string;
  tier: RenderedEvidenceTier;
  targetAssociation?: string;
  renderedEvidence: RenderedEvidence;
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
  artifactStore?: Pick<ArtifactStore, 'put'>;
  client?: { call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>; close(): void | Promise<void> };
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
        void this.close();
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

  async close(): Promise<void> {
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
    if (child && child.exitCode === null && child.signalCode === null) await terminateSidecar(child);
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
      const emittedLines = Math.min(20, chunk.split(/\r?\n/).filter(Boolean).length);
      for (let index = 0; index < emittedLines; index += 1) {
        // Native stderr is not cleared for secrets; store bounded markers only.
        this.#stderrTail.push('NATIVE_STDERR_REDACTED');
        if (this.#stderrTail.length > 20) this.#stderrTail.shift();
      }
    });

    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (Buffer.byteLength(line) > MAX_RESPONSE_LINE_BYTES) {
        void this.close();
        return;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { return; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const candidate = parsed as Record<string, unknown>;
      if (typeof candidate.id !== 'string') return;
      const pending = this.#pending.get(candidate.id);
      if (!pending) return;
      let ok: boolean;
      try { ok = strictUiaSidecarOutcome(candidate.ok); }
      catch (error) {
        clearTimeout(pending.timer);
        pending.cleanup?.();
        this.#pending.delete(candidate.id);
        pending.reject(error instanceof Error ? error : new OperatorError(
          'UIA_SIDECAR_PROTOCOL_INVALID', 'Native UIA protocol response was invalid.'));
        // Unknown native protocol state is untrusted. Do not route another
        // action through the same sidecar without starting a new process.
        void this.close();
        return;
      }
      clearTimeout(pending.timer);
      pending.cleanup?.();
      this.#pending.delete(candidate.id);
      pending.resolve({ ...candidate, id: candidate.id, ok } as SidecarResponse);
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
        reject(new OperatorError('UIA_SIDECAR_START_FAILED', 'Windows UIA sidecar could not start.', { retryable: false }));
      });
    });

    try {
      strictUiaSidecarHealth(await this.call('health', {}));
    } catch (error) {
      await this.close();
      throw error;
    }
  }
}

export class WindowsUiaProvider implements CapabilityProvider {
  readonly name = 'windows.uia';
  #platform: NodeJS.Platform;
  #client: { call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>; close(): void | Promise<void> };
  #captureLeases = new Map<string, CaptureLease>();
  #artifactStore?: Pick<ArtifactStore, 'put'>;

  constructor(options: WindowsUiaOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#artifactStore = options.artifactStore;
    const binary = options.binaryPath
      ?? process.env.OPERATOR_WINDOWS_UIA_PATH
      ?? path.join(process.cwd(), 'native', 'windows-uia', 'target', 'release', 'operator-windows-uia.exe');
    this.#client = options.client ?? new WindowsUiaSidecarClient(binary, options.timeoutMs);
  }

  supports(action: ActionRequest): boolean {
    return this.#platform === 'win32' && ['app.inspect', 'app.operate', 'visual.capture', 'input.operate'].includes(action.capability);
  }

  score(): CapabilityScore { return SCORE; }

  async reconcile(request: ProviderReconciliationRequest): Promise<ProviderReconciliationResult> {
    return reconcileFromDurableResult(this.name, request.action.capability, request.priorResult);
  }

  async execute(action: ActionRequest, context: CapabilityExecutionContext = {}): Promise<ActionResult> {
    const started = performance.now();
    try {
      if (!this.supports(action)) throw new OperatorError('UNSUPPORTED_ACTION', 'Windows UIA provider does not support this action on the current platform.');
      const operationInput = action.capability === 'app.operate'
        ? normalizeOperateInput(action.input) : undefined;
      const output = action.capability === 'app.inspect'
        ? await this.#client.call('inspect', normalizeInspectInput(action.input), context.signal)
        : action.capability === 'app.operate'
          ? await this.#client.call('operate', operationInput, context.signal)
          : action.capability === 'visual.capture'
            ? await this.#capture(action, context.signal)
            : await this.#physicalInput(action, context.signal);
      if (operationInput) strictUiaOperationIdentity(output, operationInput);
      const observedPostcondition = asRecord(asRecord(output).postcondition);
      const semanticVerified = observedPostcondition.verified === true;
      const postcondition = action.capability === 'app.operate'
        ? evidence('postcondition', semanticVerified ? 'pass' : 'info',
            semanticVerified
              ? 'Windows UIA/Win32 reported a verified semantic postcondition.'
              : 'Native operation was dispatched; the requested application effect still needs independent verification.',
            { operation: action.input.operation, waitMs: normalizeWaitMs(action.input.waitMs), verified: semanticVerified })
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
          evidence('windows_uia', 'pass', action.capability === 'app.inspect' ? 'Inspected Windows controls through Microsoft UI Automation and optional bounded Win32 discovery.' : action.capability === 'visual.capture' ? 'Captured bounded Windows visual state through the signed native sidecar.' : action.capability === 'input.operate' ? 'Dispatched capture-bound physical input through the signed native sidecar.' : 'Dispatched Windows UI Automation or semantic Win32 operation; independent application outcome verification is still required.', {}),
          postcondition
        ],
        durationMs: Math.round(performance.now() - started)
      };
    } catch (error) {
      const op = error instanceof OperatorError
        ? error
        : new OperatorError('UIA_PROVIDER_FAILED', 'Windows UIA operation failed.', { retryable: true });
      const knownCode = PUBLIC_UIA_ERROR_CODES.has(op.code);
      // A native error outside the validated protocol could have followed a
      // dispatch. It is never grounds to retry a mutating action.
      const ambiguousMutation = action.risk !== 'read'
        && (!knownCode || UNCERTAIN_UIA_MUTATION_ERRORS.has(op.code));
      // Messages and even syntactically plausible error codes can originate
      // outside our trusted boundary. Never reflect arbitrary code text.
      const publicCode = knownCode ? op.code : 'UIA_PROVIDER_FAILED';
      const publicMessage = `Windows UIA operation failed (${publicCode}).`;
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [evidence('windows_uia', 'fail', publicMessage, { code: publicCode })],
        error: { code: publicCode, message: publicMessage, retryable: ambiguousMutation ? false : op.retryable, sideEffectState: ambiguousMutation ? 'uncertain' : action.risk === 'read' ? 'none' : undefined },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }

  async #visualOutput(png: Buffer, base64: string, source: string): Promise<Record<string, unknown>> {
    if (png.byteLength <= MAX_INLINE_VISUAL_BYTES) return { imageBase64: base64 };
    if (!this.#artifactStore) {
      throw new OperatorError('VISUAL_CAPTURE_ARTIFACT_REQUIRED',
        'Large private screenshot requires a configured sensitive artifact store; raw image cannot cross the bounded tool-result channel.',
        { retryable: false });
    }
    const record=await this.#artifactStore.put({
      bytes: png,kind:'screenshot',mediaType:'image/png',privacy:'sensitive',
      metadata:{source,transport:'immutable-artifact-reference'}
    });
    return {imageArtifactId:record.id,imageSha256:record.blobDigest,
      imageByteLength:record.bytes,imagePrivacy:'sensitive'};
  }

  async #capture(action: ActionRequest, signal?: AbortSignal): Promise<unknown> {
    this.#pruneCaptureLeases();
    const captureParams = normalizeVisualCaptureInput(action.input);
    const raw = asRecord(await this.#client.call('capture', captureParams, signal));
    // Never return a full-screen capture in response to a region/window request.
    // The native helper must echo the exact selected capture source.
    if (raw.source !== captureParams.source) {
      throw new OperatorError('VISUAL_CAPTURE_INVALID', 'Native capture source differs from the authorized source.');
    }
    const pngBase64 = strictNativeCaptureBase64(raw.png_base64, 'initial');
    const png = Buffer.from(pngBase64, 'base64');
    if (png.length < 16 || png.length > 8 * 1024 * 1024) throw new OperatorError('VISUAL_CAPTURE_INVALID', 'Native capture returned an invalid PNG payload.');
    const sha256 = crypto.createHash('sha256').update(png).digest('hex');
    const captureId = crypto.randomUUID();
    const now = Date.now();
    const originX = boundedCaptureInteger(raw.origin_x, -100_000, 100_000, 'origin_x');
    const originY = boundedCaptureInteger(raw.origin_y, -100_000, 100_000, 'origin_y');
    const sourceWidth = boundedCaptureInteger(raw.source_width, 1, 100_000, 'source_width');
    const sourceHeight = boundedCaptureInteger(raw.source_height, 1, 100_000, 'source_height');
    const returnedWidth = boundedCaptureInteger(raw.returned_width, 1, 1280, 'returned_width');
    const returnedHeight = boundedCaptureInteger(raw.returned_height, 1, 720, 'returned_height');
    const scaleX = boundedCaptureNumber(raw.scale_x, 0.0001, 1000, 'scale_x');
    const scaleY = boundedCaptureNumber(raw.scale_y, 0.0001, 1000, 'scale_y');
    const windowId = typeof raw.window_id === 'string' && raw.window_id ? raw.window_id : undefined;
    // The native helper does not clip authorized regions: the returned pixels
    // must have the exact requested geometry, not merely claim source=region.
    // Validate before storing sensitive evidence or leasing pointer authority.
    if (captureParams.source === 'region') {
      const region = captureParams.region as {x:number;y:number;width:number;height:number};
      if (originX !== region.x || originY !== region.y ||
          sourceWidth !== region.width || sourceHeight !== region.height) {
        throw new OperatorError('VISUAL_CAPTURE_INVALID', 'Native capture region differs from the authorized coordinates.');
      }
    }
    if (captureParams.source === 'window' && !windowId) {
      throw new OperatorError('VISUAL_CAPTURE_INVALID', 'Native window capture lacked the resolved window identity.');
    }
    const sceneKey = windowId ? `desktop:window:${windowId.toLocaleLowerCase()}` : 'visual:screen';
    const tier = renderedTier(action.input.evidenceTier, String(captureParams.source));
    const targetAssociation = optionalCaptureText(action.input.targetAssociation, 'targetAssociation', 512);
    const renderedEvidence = createRenderedEvidence({
      tier,
      sceneKey,
      captureId,
      captureGeneration: sha256,
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + CAPTURE_LEASE_MS).toISOString(),
      region: { x: originX, y: originY, width: sourceWidth, height: sourceHeight },
      sourceDimensions: { width: sourceWidth, height: sourceHeight },
      returnedDimensions: { width: returnedWidth, height: returnedHeight },
      transform: {
        from: 'capture-image', to: 'native-screen', originX, originY, scaleX, scaleY,
        sourceWidth: returnedWidth, sourceHeight: returnedHeight,
        targetWidth: sourceWidth, targetHeight: sourceHeight,
        generation: sha256,
        provenance: `${this.name}:visual.capture:${captureId}`
      },
      ...(targetAssociation ? { targetAssociation } : {})
    });
    const lease: CaptureLease = {
      captureId, sha256, createdAt: now, expiresAt: now + CAPTURE_LEASE_MS,
      originX, originY, sourceWidth, sourceHeight, returnedWidth, returnedHeight, scaleX, scaleY,
      captureParams: structuredClone(captureParams),
      ...(windowId ? { windowId } : {}),
      sceneKey, tier, ...(targetAssociation ? { targetAssociation } : {}), renderedEvidence
    };
    const visualPayload = await this.#visualOutput(png, pngBase64, String(captureParams.source));
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
      renderedEvidence,
      mimeType: 'image/png',
      ...visualPayload
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
    const operation = strictPhysicalInputOperation(action.input.operation);
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
    const currentBase64 = strictNativeCaptureBase64(currentRaw.png_base64, 'before_input');
    const currentPng = Buffer.from(currentBase64, 'base64');
    if (currentPng.length < 16 || currentPng.length > 8 * 1024 * 1024) {
      this.#captureLeases.delete(captureId);
      throw new OperatorError('INPUT_CAPTURE_INVALID', 'Fresh pre-input capture returned an invalid PNG payload.', { retryable: true });
    }
    const currentSha256 = crypto.createHash('sha256').update(currentPng).digest('hex');
    const currentWindowId = typeof currentRaw.window_id === 'string' ? currentRaw.window_id : undefined;
    // An unchanged screenshot hash cannot prove stable physical coordinates.
    // A window can move or DPI/monitor scaling can change over identical pixels.
    // Reject mismatched native geometry/source *before* dispatching any input.
    const sameGeometry =
      currentRaw.source === lease.captureParams.source &&
      currentRaw.origin_x === lease.originX &&
      currentRaw.origin_y === lease.originY &&
      currentRaw.source_width === lease.sourceWidth &&
      currentRaw.source_height === lease.sourceHeight &&
      currentRaw.returned_width === lease.returnedWidth &&
      currentRaw.returned_height === lease.returnedHeight &&
      currentRaw.scale_x === lease.scaleX &&
      currentRaw.scale_y === lease.scaleY;
    if (currentSha256 !== lease.sha256 || !sameGeometry ||
        (lease.windowId && currentWindowId !== lease.windowId)) {
      this.#captureLeases.delete(captureId);
      throw new OperatorError('INPUT_CAPTURE_STALE', 'Visual state or physical geometry changed after reasoning; capture fresh state before input.', { retryable: true });
    }

    const before = {
      captureId,
      sha256: lease.sha256,
      revalidatedSha256: currentSha256,
      expiresAt: new Date(lease.expiresAt).toISOString(),
      ...(lease.windowId ? { windowId: lease.windowId } : {})
    };
    // Consume the capture lease BEFORE the native dispatch. If the response is
    // lost after input reaches Windows, a second invocation must not be able
    // to replay using the original screenshot/approval.
    this.#captureLeases.delete(captureId);
    const native = strictNativeInputResult(
      await this.#client.call('input', params, signal), operation, Boolean(lease.windowId)
    );
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
    const afterBase64 = strictNativeCaptureBase64(afterRaw.png_base64, 'after_input');
    const afterPng = Buffer.from(afterBase64, 'base64');
    if (afterPng.length < 16 || afterPng.length > 8 * 1024 * 1024) {
      throw new OperatorError('INPUT_AFTER_CAPTURE_INVALID', 'Physical input was dispatched but AFTER capture returned an invalid PNG payload.', { retryable: false });
    }
    // The post-input capture is observational proof, not authority to persist
    // pixels from a different scope or native window. The input has already
    // been dispatched, so any mismatch is an UNCERTAIN result, never a retry.
    if (afterRaw.source !== lease.captureParams.source) {
      throw new OperatorError('INPUT_AFTER_SOURCE_CHANGED', 'Physical input was dispatched but AFTER capture used a different source.', { retryable: false });
    }
    const afterWindowId = typeof afterRaw.window_id === 'string' && afterRaw.window_id ? afterRaw.window_id : undefined;
    if (lease.windowId && afterWindowId !== lease.windowId) {
      throw new OperatorError('INPUT_AFTER_WINDOW_CHANGED', 'Physical input was dispatched but AFTER capture resolved to a different window.', { retryable: false });
    }
    const afterSha256 = crypto.createHash('sha256').update(afterPng).digest('hex');
    const afterObservedAt = Date.now();
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
      mimeType: 'image/png'
    };
    const afterRenderedEvidence = createRenderedEvidence({
      tier: lease.tier,
      sceneKey: lease.sceneKey,
      captureId: `${captureId}:after`,
      captureGeneration: afterSha256,
      observedAt: new Date(afterObservedAt).toISOString(),
      expiresAt: new Date(afterObservedAt + CAPTURE_LEASE_MS).toISOString(),
      region: { x: after.originX, y: after.originY, width: after.sourceWidth, height: after.sourceHeight },
      sourceDimensions: { width: after.sourceWidth, height: after.sourceHeight },
      returnedDimensions: { width: after.width, height: after.height },
      transform: {
        from: 'capture-image', to: 'native-screen', originX: after.originX, originY: after.originY,
        scaleX: after.sourceWidth / after.width, scaleY: after.sourceHeight / after.height,
        sourceWidth: after.width, sourceHeight: after.height,
        targetWidth: after.sourceWidth, targetHeight: after.sourceHeight,
        generation: afterSha256,
        provenance: `${this.name}:input.operate:${captureId}:after`
      },
      ...(lease.targetAssociation ? { targetAssociation: lease.targetAssociation } : {})
    });
    const regionStable = sameCaptureRegion(lease.renderedEvidence, afterRenderedEvidence);
    const renderedDelta = regionStable ? createRenderedDeltaEvidence(lease.renderedEvidence, afterRenderedEvidence) : undefined;
    return {
      operation,
      before: { ...before, renderedEvidence: lease.renderedEvidence },
      native,
      after: { ...after, ...await this.#visualOutput(afterPng, afterBase64, String(afterRaw.source)), renderedEvidence: afterRenderedEvidence },
      ...(renderedDelta ? { renderedDelta } : {}),
      postcondition: {
        dispatched: true,
        captureLeaseConsumed: true,
        afterCaptured: true,
        afterSha256,
        changed: after.changed,
        windowStable: lease.windowId ? after.windowId === lease.windowId : true,
        regionStable,
        verificationScope: renderedDelta?.scope ?? 'capture-region-changed'
      }
    };
  }

  #pruneCaptureLeases(): void {
    const now = Date.now();
    for (const [captureId, lease] of this.#captureLeases) if (lease.expiresAt <= now) this.#captureLeases.delete(captureId);
  }

  async emergencyStop(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    this.#captureLeases.clear();
    await this.#client.close();
  }
}

async function terminateSidecar(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try { child.kill('SIGTERM'); } catch { /* postcondition below decides */ }
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch { /* postcondition below decides */ }
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
  }
  if (child.exitCode === null && child.signalCode === null) throw new OperatorError('UIA_SIDECAR_TERMINATE_FAILED', 'Windows UIA sidecar remained alive after shutdown.', { retryable: false });
}

function normalizeSelector(input: unknown, exactMutationTarget = false) {
  if (exactMutationTarget && (!input || typeof input !== 'object' || Array.isArray(input))) {
    throw new OperatorError('INVALID_UIA_SELECTOR', 'Mutating UIA operation requires a semantic selector object.');
  }
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  if (exactMutationTarget && Object.keys(raw).some(key =>
    !['name', 'automationId', 'className', 'controlType', 'processId'].includes(key))) {
    throw new OperatorError('INVALID_UIA_SELECTOR', 'UIA mutation selector contains unsupported identity fields.');
  }
  const text = (key: string) => {
    const candidate = raw[key];
    if (candidate === undefined) return undefined;
    if (typeof candidate !== 'string' || !candidate.trim()) {
      if (exactMutationTarget) throw new OperatorError('INVALID_UIA_SELECTOR', 'UIA mutation selector must have exact bounded string fields.');
      return undefined;
    }
    // An exact mutation identity must not be silently trimmed or shortened:
    // " Save " and "Save" may select different controls.
    if (exactMutationTarget) {
      if (candidate !== candidate.trim() || candidate.length > 512) {
        throw new OperatorError('INVALID_UIA_SELECTOR', 'UIA mutation selector must preserve exact bounded identity text.');
      }
      return candidate;
    }
    return candidate.trim().slice(0, 512) || undefined;
  };
  const processId = Number.isSafeInteger(raw.processId) && Number(raw.processId) > 0 && Number(raw.processId) <= 0x7fffffff
    ? Number(raw.processId) : undefined;
  if (exactMutationTarget && raw.processId !== undefined && processId === undefined) {
    throw new OperatorError('INVALID_UIA_SELECTOR', 'UIA mutation process identity is invalid.');
  }
  const selector = {
    name: text('name'),
    automation_id: text('automationId'),
    class_name: text('className'),
    control_type: text('controlType'),
    process_id: processId
  };
  if (exactMutationTarget && Object.values(selector).every(value => value === undefined)) {
    throw new OperatorError('INVALID_UIA_SELECTOR', 'Mutating UIA operation requires at least one exact target identity.');
  }
  return selector;
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

function boundedInspectLimit(value: unknown, maximum: number, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new OperatorError('INVALID_UIA_INSPECT_LIMIT', field + ' must be an exact positive integer within the native helper limit.');
  }
  return Number(value);
}
function normalizeInspectInput(input: Record<string, unknown>) {
  return {
    selector: input.selector ? normalizeSelector(input.selector) : undefined,
    max_nodes: boundedInspectLimit(input.maxNodes, 1500, 'maxNodes'),
    max_depth: boundedInspectLimit(input.maxDepth, 12, 'maxDepth'),
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
  const operation = input.operation;
  if (typeof operation !== 'string' || !(UIA_OPERATIONS as readonly string[]).includes(operation)) {
    throw new OperatorError('INVALID_UIA_OPERATION', `operation must be ${UIA_OPERATIONS.join(', ')}.`);
  }
  const horizontalAmount = normalizeScrollAmount(input.horizontalAmount, 'horizontalAmount');
  const verticalAmount = normalizeScrollAmount(input.verticalAmount, 'verticalAmount');
  if (operation === 'scroll' && horizontalAmount === undefined && verticalAmount === undefined) {
    throw new OperatorError('INVALID_UIA_SCROLL_AMOUNT', 'scroll requires horizontalAmount or verticalAmount.');
  }
  if ((operation === 'set_value' && typeof input.value !== 'string') ||
      (input.value !== undefined && (typeof input.value !== 'string' ||
        Buffer.byteLength(input.value, 'utf8') > 64 * 1024 || input.value.includes(String.fromCharCode(0))))) {
    throw new OperatorError('INVALID_UIA_VALUE', 'UIA value must be a bounded string, required for set_value.');
  }
  return {
    operation,
    selector: normalizeSelector(input.selector, true),
    value: input.value,
    horizontal_amount: horizontalAmount,
    vertical_amount: verticalAmount,
    wait_ms: normalizeWaitMs(input.waitMs)
  };
}


function normalizeVisualCaptureInput(input: Record<string, unknown>): Record<string, unknown> {
  const source = input.source === undefined ? 'screen' : input.source;
  if (source !== 'screen' && source !== 'window' && source !== 'region') {
    throw new OperatorError('VISUAL_CAPTURE_INVALID', 'Visual capture source must be explicitly screen, window or region.');
  }
  if ((source === 'screen' && (input.selector !== undefined || input.region !== undefined)) ||
      (source === 'window' && input.region !== undefined) ||
      (source === 'region' && input.selector !== undefined)) {
    throw new OperatorError('VISUAL_CAPTURE_INVALID', 'Capture selector and region must match the exact selected source.');
  }
  const output: Record<string, unknown> = {
    source,
    max_width: boundedCaptureInteger(input.maxWidth ?? 960, 1, 1280, 'maxWidth'),
    max_height: boundedCaptureInteger(input.maxHeight ?? 540, 1, 720, 'maxHeight'),
    wait_ms: boundedCaptureInteger(input.waitMs ?? 0, 0, 10_000, 'waitMs')
  };
  if (source === 'window') output.selector = normalizeSelector(input.selector, true);
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
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new OperatorError('VISUAL_INPUT_INVALID', `${label} must be an exact integer from ${min} to ${max}.`);
  }
  return value;
}

function boundedCaptureNumber(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new OperatorError('VISUAL_CAPTURE_INVALID', `${label} must be an exact finite number within the allowed range.`);
  }
  return value;
}

function requiredCaptureText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new OperatorError('VISUAL_INPUT_INVALID', `${label} is invalid.`);
  return value;
}

function optionalCaptureText(value: unknown, label: string, max: number): string | undefined {
  return value === undefined ? undefined : requiredCaptureText(value, label, max);
}

function renderedTier(value: unknown, source: string): RenderedEvidenceTier {
  if (value === undefined) return source === 'region' ? 'target-roi' : 'full-capture';
  if (value === 'target-roi' || value === 'changed-region' || value === 'full-capture') return value;
  throw new OperatorError('VISUAL_INPUT_INVALID', 'evidenceTier must be target-roi, changed-region, or full-capture.');
}

function sameCaptureRegion(before: RenderedEvidence, after: RenderedEvidence): boolean {
  return before.sceneKey === after.sceneKey
    && before.region.x === after.region.x
    && before.region.y === after.region.y
    && before.region.width === after.region.width
    && before.region.height === after.region.height;
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
