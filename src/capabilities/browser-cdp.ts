import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { ActionRequest, ActionResult, CapabilityExecutionContext, CapabilityProvider, CapabilityScore, ProviderReconciliationResult } from '../core/types.ts';
import { canonicalJson } from '../core/action-identity.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { CdpConnection, CdpSessionManager, type CdpTarget, type JsonMap } from './browser-cdp-connection.ts';
import { inspectOopifFrames, observeSemanticTargetState, performSemanticInteraction } from './browser-cdp-frames.ts';
import {
  assertLoopbackEndpoint,
  collectDiagnostics,
  compactTab,
  failure,
  inspectPage,
  normalizeObservationOptions,
  normalizeTargetSpec,
  pageIdentity,
  requirePageTarget,
  requireTarget,
  sameDestination,
  settleAfterInteraction,
  unwrapRuntimeValue,
  validateNavigationUrl,
  waitForDestinationReady
} from './browser-cdp-page.ts';

const SCORE: CapabilityScore = {
  reliability: 0.96,
  latency: 0.97,
  determinism: 0.97,
  security: 0.93,
  reversibility: 0.9,
  informationQuality: 0.96,
  interactionCost: 0.01
};

/** Browser target identity must not be derived from object/array coercion. */
function optionalTargetId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) {
    throw new OperatorError('INVALID_BROWSER_TARGET', 'Browser targetId must be an exact bounded target identity.');
  }
  return value;
}
function requiredTargetId(value: unknown): string {
  const id = optionalTargetId(value);
  if (!id) throw new OperatorError('INVALID_BROWSER_TARGET', 'targetId is required.');
  return id;
}
/** The source and destination of a drag must come from one current,
 * generation-tagged semantic observation, not two different page snapshots. */
function dragRefsShareGeneration(source: string, destination: string): boolean {
  const pattern = /^b-([a-z0-9]+)-([a-z0-9]+)-([a-z0-9]+)$/;
  const a = pattern.exec(source);
  const b = pattern.exec(destination);
  return Boolean(a && b && a[1] === b[1] && a[2] === b[2] && source !== destination);
}
function exactDelta(value: unknown): number | undefined {
  return value === undefined ? 0 : typeof value === 'number' ? value : undefined;
}
function optionalCoordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The provider's verification RPC can complete successfully while its
 * requested postconditions remain false or inconclusive. Such responses are
 * never success receipts for recovering an uncertain browser interaction. */
export function browserVerificationProven(result: ActionResult): boolean {
  if (!result?.ok || !result.output || typeof result.output !== 'object') return false;
  const output = result.output as Record<string, unknown>;
  if (output.status !== 'VERIFIED' || !Array.isArray(output.checks) || !output.checks.length) return false;
  return output.checks.every(check => check && typeof check === 'object' &&
    (check as Record<string, unknown>).pass === true);
}
export function normalizeBrowserVerificationExpectations(value: unknown): JsonMap {
  const keys = ['exists', 'value', 'checked', 'selected', 'expanded', 'current',
    'active', 'urlContains', 'titleContains', 'textContains'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperatorError('INVALID_BROWSER_VERIFICATION', 'Expected browser postconditions must be an object.');
  }
  const record = value as JsonMap;
  const present = Object.keys(record);
  if (!present.length || present.length > keys.length ||
      present.some(key => !keys.includes(key)) ||
      !present.some(key => record[key] !== undefined)) {
    throw new OperatorError('INVALID_BROWSER_VERIFICATION', 'At least one supported browser postcondition is required and unknown keys are refused.');
  }
  for (const key of present) {
    const expected = record[key];
    if (expected === undefined) {
      throw new OperatorError('INVALID_BROWSER_VERIFICATION', 'Undefined browser expectation values are invalid.');
    }
    if (['exists', 'checked', 'selected', 'expanded', 'active'].includes(key)) {
      if (typeof expected !== 'boolean') {
        throw new OperatorError('INVALID_BROWSER_VERIFICATION', 'Boolean browser postconditions require exact Boolean values.');
      }
    } else if (key === 'value') {
      if (!((typeof expected === 'string' && expected.length <= 2048) ||
            (typeof expected === 'number' && Number.isFinite(expected)))) {
        throw new OperatorError('INVALID_BROWSER_VERIFICATION', 'Browser value expectation must be a bounded scalar.');
      }
    } else if (typeof expected !== 'string' || !expected.trim() || expected.length > 2048) {
      throw new OperatorError('INVALID_BROWSER_VERIFICATION', 'Browser string postconditions require a non-empty bounded string.');
    }
  }
  return record;
}

/** Browser recovery cannot infer which tab was navigated from a URL match:
 * any preexisting tab may already have the requested URL. */
export function exactNavigationReconciliationTarget(
  targets: readonly Pick<CdpTarget,'id'|'type'|'url'>[],
  requestedTargetId: unknown,
  requestedUrl: string
): Pick<CdpTarget,'id'|'type'|'url'> | undefined {
  if (typeof requestedTargetId !== 'string' || !requestedTargetId) return undefined;
  return targets.find(item => item.id === requestedTargetId && item.type === 'page' &&
    typeof item.url === 'string' && sameDestination(item.url,requestedUrl));
}
export function browserFocusActuallyProven(observed: unknown): boolean {
  return Boolean(observed && typeof observed === 'object' &&
    !Array.isArray(observed) &&
    (observed as Record<string,unknown>).visible === true &&
    (observed as Record<string,unknown>).focused === true);
}
export function absentBrowserTargetChecks(expect: JsonMap):
  Array<{field:string;expected:unknown;actual:unknown;pass:boolean}> {
  const checks: Array<{field:string;expected:unknown;actual:unknown;pass:boolean}>=[{field:'exists',expected:expect.exists??true,actual:false,
    pass:expect.exists===false}];
  for(const field of ['value','checked','selected','expanded','current','active']) {
    if (expect[field] !== undefined) checks.push({
      field,expected:expect[field],actual:undefined,pass:false
    });
  }
  return checks;
}
const MAX_TABS = 100;
const MAX_CDP_DISCOVERY_BYTES = 1024 * 1024;

/**
 * CDP target enumeration is an authority-bearing observation. Discarding
 * excess targets or coercing foreign IDs could choose the wrong tab when
 * multiple pages are present, so incomplete discovery must fail closed.
 */
export function normalizeCdpTargets(input: unknown): CdpTarget[] {
  if (!Array.isArray(input)) {
    throw new OperatorError('CDP_DISCOVERY_INVALID',
      'Browser target discovery must return an array of target objects.');
  }
  if (input.length > MAX_TABS) {
    throw new OperatorError('CDP_DISCOVERY_INCOMPLETE',
      'Browser target inventory exceeds the supported bound; choose a smaller dedicated browser session.');
  }
  const seen = new Set<string>();
  return input.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new OperatorError('CDP_DISCOVERY_INVALID', 'CDP target inventory contains a non-object target.');
    }
    const tab = value as Record<string, unknown>;
    if (typeof tab.id !== 'string' ||
        !/^[A-Za-z0-9._:-]{1,256}$/.test(tab.id) || seen.has(tab.id)) {
      throw new OperatorError('CDP_DISCOVERY_INVALID',
        `CDP target inventory contains an invalid or duplicate target identity at position ${index}.`);
    }
    seen.add(tab.id);
    const field = (key: 'type' | 'title' | 'url' | 'webSocketDebuggerUrl', max: number) => {
      const entry = tab[key];
      if (entry === undefined) return undefined;
      if (typeof entry !== 'string' || entry.length > max || entry.includes(String.fromCharCode(0))) {
        throw new OperatorError('CDP_DISCOVERY_INVALID',
          'CDP target inventory returned a malformed optional identity field.');
      }
      return entry;
    };
    return {
      id: tab.id,
      ...(field('type', 64) !== undefined ? { type: field('type', 64) } : {}),
      ...(field('title', 4096) !== undefined ? { title: field('title', 4096) } : {}),
      ...(field('url', 8192) !== undefined ? { url: field('url', 8192) } : {}),
      ...(field('webSocketDebuggerUrl', 8192) !== undefined
        ? { webSocketDebuggerUrl: field('webSocketDebuggerUrl', 8192) } : {})
    };
  });
}


/** Never let an oversized or malformed loopback DevTools endpoint allocate an
 * unbounded discovery response. This is independent of the inspect output cap.
 */
export async function boundedDiscoveryJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_CDP_DISCOVERY_BYTES) {
    throw new OperatorError('CDP_DISCOVERY_TOO_LARGE', 'Browser target discovery exceeds the permitted byte limit.');
  }
  if (!response.body) throw new OperatorError('CDP_DISCOVERY_INVALID', 'Browser target discovery response has no body.');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let reads = 0;
  let consecutiveEmpty = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // Bounded bytes alone cannot stop a malicious endpoint that streams
      // empty chunks forever. Reject type confusion and stalled progress.
      if (++reads > 65_536 || !(value instanceof Uint8Array)) {
        await reader.cancel();
        throw new OperatorError('CDP_DISCOVERY_INVALID', 'Browser discovery stream has invalid or unbounded chunks.');
      }
      if (value.byteLength === 0) {
        if (++consecutiveEmpty > 4) {
          await reader.cancel();
          throw new OperatorError('CDP_DISCOVERY_STALLED', 'Browser discovery stream made no progress.');
        }
        continue;
      }
      consecutiveEmpty = 0;
      bytes += value.byteLength;
      if (bytes > MAX_CDP_DISCOVERY_BYTES) {
        await reader.cancel();
        throw new OperatorError('CDP_DISCOVERY_TOO_LARGE', 'Browser target discovery exceeds the permitted byte limit.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown;
  } catch {
    throw new OperatorError('CDP_DISCOVERY_INVALID', 'Browser target discovery returned malformed JSON.');
  }
}

type BrowserDownloadEvent = { guid: string; state: string; url?: string; suggestedFilename?: string; receivedBytes?: number; totalBytes?: number; filePath?: string };
type DownloadTracker = {
  done: Promise<BrowserDownloadEvent>;
  stop(): void;
};

const MAX_HASHED_DOWNLOAD_BYTES = 512 * 1024 * 1024;

function sameDownloadFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && (left.ino === 0 || right.ino === 0 || left.ino === right.ino);
}

async function bindCompletedDownloadArtifact(
  download: BrowserDownloadEvent,
  targetId: string,
  target: JsonMap,
  signal?: AbortSignal
): Promise<BrowserDownloadEvent & Record<string, unknown>> {
  const bound = {
    ...download,
    initiatingTargetId: targetId,
    actionTargetDigest: crypto.createHash('sha256').update(canonicalJson({ targetId, target })).digest('hex'),
    completedAt: new Date().toISOString()
  };
  if (signal?.aborted) throw abortError();
  if (download.state !== 'completed' || !download.filePath) return bound;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (signal?.aborted) throw abortError();
    const before = await lstat(download.filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 0 || before.size > MAX_HASHED_DOWNLOAD_BYTES) return { ...bound, artifactStatus: 'unavailable' };
    if (signal?.aborted) throw abortError();
    handle = await open(download.filePath, fsConstants.O_RDONLY);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameDownloadFile(before, opened)
      || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) return { ...bound, artifactStatus: 'unavailable' };
    const digest = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let artifactBytes = 0;
    while (artifactBytes < opened.size) {
      if (signal?.aborted) throw abortError();
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, opened.size - artifactBytes), artifactBytes);
      if (bytesRead < 1) return { ...bound, artifactStatus: 'unavailable' };
      artifactBytes += bytesRead;
      digest.update(chunk.subarray(0, bytesRead));
    }
    if (signal?.aborted) throw abortError();
    const after = await handle.stat();
    const finalPath = await lstat(download.filePath);
    if (signal?.aborted) throw abortError();
    if (artifactBytes !== opened.size || !sameDownloadFile(opened, after)
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || finalPath.isSymbolicLink() || !sameDownloadFile(opened, finalPath)
      || finalPath.size !== opened.size || finalPath.mtimeMs !== opened.mtimeMs) {
      return { ...bound, artifactStatus: 'unavailable' };
    }
    return { ...bound, artifactStatus: 'hashed', artifactSha256: digest.digest('hex'), artifactBytes };
  } catch {
    // A deliberate owner Stop is never a completed, harmless hash fallback.
    // It must reach the dispatched-side-effect cancellation fence.
    if (signal?.aborted) throw abortError();
    return { ...bound, artifactStatus: 'unavailable' };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const JAVASCRIPT_DIALOG_TYPES = new Set(['alert', 'confirm', 'prompt', 'beforeunload']);
const DIALOG_REF = /^bd-[0-9a-f]{16}-[1-9a-z][0-9a-z]*-[0-9a-f]{12}$/;

export interface BrowserJavaScriptDialogObservation {
  state: 'open';
  ref: string;
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  messageDigest: string;
  messageLength: number;
  sourceOrigin?: string;
  hasBrowserHandler: boolean;
  defaultPromptPresent: boolean;
  observedAt: string;
}

type BrowserDialogClosure = {
  ref: string;
  result: boolean;
  observedAt: string;
};

type BrowserDialogWatch = {
  targetId: string;
  session: CdpConnection;
  generation: number;
  current?: BrowserJavaScriptDialogObservation;
  lastClosed?: BrowserDialogClosure;
  invalidEvent?: boolean;
  stop(): void;
};

type BrowserDialogAction = {
  operation: 'dialog_accept' | 'dialog_dismiss';
  targetId: string;
  dialogRef: string;
  promptText?: string;
};

function dialogSourceOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch { return undefined; }
}

/** Normalize an untrusted CDP dialog event without exporting prompt contents. */
export function normalizeJavaScriptDialogObservation(input: {
  params: unknown;
  targetId: string;
  instanceNonce: string;
  generation: number;
  observedAt?: string;
}): BrowserJavaScriptDialogObservation {
  const params = input.params;
  if (!params || typeof params !== 'object' || Array.isArray(params) ||
      typeof input.targetId !== 'string' || !input.targetId || input.targetId.length > 256 ||
      !/^[0-9a-f]{16}$/.test(input.instanceNonce) ||
      !Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new OperatorError('BROWSER_DIALOG_EVENT_INVALID', 'JavaScript dialog event identity is invalid.');
  }
  const record = params as JsonMap;
  if (typeof record.type !== 'string' || !JAVASCRIPT_DIALOG_TYPES.has(record.type) ||
      typeof record.message !== 'string' || Buffer.byteLength(record.message, 'utf8') > 64 * 1024 ||
      typeof record.hasBrowserHandler !== 'boolean' ||
      (record.defaultPrompt !== undefined && typeof record.defaultPrompt !== 'string')) {
    throw new OperatorError('BROWSER_DIALOG_EVENT_INVALID', 'JavaScript dialog event has an unsupported or malformed shape.');
  }
  const observedAt = input.observedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) {
    throw new OperatorError('BROWSER_DIALOG_EVENT_INVALID', 'JavaScript dialog observation time is invalid.');
  }
  const message = record.message;
  const targetDigest = crypto.createHash('sha256').update(input.targetId, 'utf8').digest('hex').slice(0, 12);
  return {
    state: 'open',
    ref: `bd-${input.instanceNonce}-${input.generation.toString(36)}-${targetDigest}`,
    type: record.type as BrowserJavaScriptDialogObservation['type'],
    messageDigest: crypto.createHash('sha256').update(message, 'utf8').digest('hex'),
    messageLength: message.length,
    ...(dialogSourceOrigin(record.url) ? { sourceOrigin: dialogSourceOrigin(record.url) } : {}),
    hasBrowserHandler: record.hasBrowserHandler,
    defaultPromptPresent: typeof record.defaultPrompt === 'string' && record.defaultPrompt.length > 0,
    observedAt
  };
}

/** Closed input contract for JavaScript dialog actions. */
export function normalizeBrowserDialogAction(input: unknown): BrowserDialogAction {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OperatorError('INVALID_BROWSER_DIALOG_ACTION', 'Browser dialog action must be an object.');
  }
  const record = input as JsonMap;
  const allowed = new Set(['targetId', 'operation', 'dialogRef', 'promptText']);
  if (Object.keys(record).some((key) => !allowed.has(key)) ||
      (record.operation !== 'dialog_accept' && record.operation !== 'dialog_dismiss') ||
      typeof record.targetId !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(record.targetId) ||
      typeof record.dialogRef !== 'string' || !DIALOG_REF.test(record.dialogRef)) {
    throw new OperatorError('INVALID_BROWSER_DIALOG_ACTION', 'Browser dialog action identity or fields are invalid.');
  }
  if (record.promptText !== undefined &&
      (typeof record.promptText !== 'string' || record.promptText.length > 4096 || record.promptText.includes('\0'))) {
    throw new OperatorError('INVALID_BROWSER_DIALOG_PROMPT', 'Dialog promptText must be an exact bounded string without NUL characters.');
  }
  if (record.operation === 'dialog_dismiss' && record.promptText !== undefined) {
    throw new OperatorError('INVALID_BROWSER_DIALOG_PROMPT', 'Dismissed dialogs cannot supply promptText.');
  }
  return {
    operation: record.operation,
    targetId: record.targetId,
    dialogRef: record.dialogRef,
    ...(record.promptText !== undefined ? { promptText: record.promptText } : {})
  };
}

function browserReconciliation(
  status: ProviderReconciliationResult['status'],
  message: string
): ProviderReconciliationResult {
  return {
    status,
    evidence: [evidence('browser_reconciliation', status === 'completed' ? 'pass' : 'info', message)]
  };
}

function browserReconciled(
  action: ActionRequest,
  provider: string,
  message: string,
  output: Record<string, unknown>,
  extraEvidence: ReturnType<typeof evidence>[] = []
): ProviderReconciliationResult {
  const reconciledEvidence = [
    evidence('browser_reconciliation', 'pass', message, output),
    ...extraEvidence
  ];
  const result: ActionResult = {
    ok: true,
    capability: action.capability,
    provider,
    output: { ...output, reconciled: true },
    evidence: reconciledEvidence,
    durationMs: 0
  };
  return { status: 'completed', result, evidence: reconciledEvidence };
}

export class BrowserCdpProvider implements CapabilityProvider {
  readonly name = 'browser.cdp';
  #endpoint: URL;
  #sessions = new CdpSessionManager();
  #browserSession?: CdpConnection;
  #dialogInstanceNonce = crypto.randomBytes(8).toString('hex');
  #dialogWatches = new Map<string, BrowserDialogWatch>();
  #noProgressHistory = new Map<string, number>();
  #noProgressPrevented = 0;

  constructor(endpoint = 'http://127.0.0.1:9222') {
    this.#endpoint = new URL(endpoint);
    assertLoopbackEndpoint(this.#endpoint);
  }

  supports(action: ActionRequest): boolean {
    return ['browser.inspect', 'browser.verify', 'browser.navigate', 'browser.interact', 'browser.tab.focus', 'browser.tab.close'].includes(action.capability);
  }

  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest, context: CapabilityExecutionContext = {}): Promise<ActionResult> {
    const started = performance.now();
    try {
      throwIfAborted(context.signal);
      if (action.capability === 'browser.inspect') return await this.#inspect(action, started, context.signal);
      if (action.capability === 'browser.verify') return await this.#verify(action, started, context.signal);
      if (action.capability === 'browser.navigate') return await this.#navigate(action, started, context.signal);
      if (action.capability === 'browser.interact') return await this.#interact(action, started, context.signal);
      if (action.capability === 'browser.tab.focus') return await this.#focusTab(action, started, context.signal);
      if (action.capability === 'browser.tab.close') return await this.#closeTab(action, started, context.signal);
      throw new OperatorError('UNSUPPORTED_ACTION', action.capability);
    } catch (error) {
      // Cancellation before dispatch is side-effect-free. Once a provider has
      // attached an execution phase, preserve that stronger truth instead of
      // laundering an uncertain dispatched effect into a generic abort.
      const caught = context.signal?.aborted && !(error instanceof OperatorError &&
        error.details?.executionPhase !== undefined && error.details?.sideEffectState !== undefined)
        ? abortError()
        : error;
      const normalized = action.capability === 'browser.interact'
        && caught instanceof OperatorError
        && caught.details?.executionPhase === undefined
        && caught.details?.sideEffectState === undefined
        ? new OperatorError(caught.code, caught.message, {
            retryable: caught.retryable,
            details: { ...(caught.details ?? {}), sideEffectState: 'none', executionPhase: 'pre_dispatch' }
          })
        : caught;
      return failure(action, this.name, started, normalized);
    }
  }

  close(): void {
    for (const watch of this.#dialogWatches.values()) watch.stop();
    this.#dialogWatches.clear();
    this.#sessions.closeAll();
    this.#browserSession?.close();
    this.#browserSession = undefined;
  }

  async reconcile(
    { action }: { action: ActionRequest; priorResult?: ActionResult },
    context: CapabilityExecutionContext = {}
  ): Promise<ProviderReconciliationResult> {
    try {
      if (action.capability === 'browser.navigate') {
        const requestedUrl = validateNavigationUrl(action.input.url);
        const tabs = await this.#listTargets(context.signal);
        const requestedTargetId = optionalTargetId(action.input.targetId);
        const target = exactNavigationReconciliationTarget(tabs,requestedTargetId,requestedUrl);
        if (target) {
          return browserReconciled(action, this.name, 'Fresh inspection proves the exact requested browser target is at its destination.', {
            targetId: target.id, url: target.url
          });
        }
        return browserReconciliation('uncertain', requestedTargetId
          ? 'The exact requested browser target does not prove navigation succeeded.'
          : 'No originally bound targetId exists; a coincidental URL match in another tab cannot prove navigation or new-tab creation.');
      }

      if (action.capability === 'browser.tab.close') {
        const targetId = optionalTargetId(action.input.targetId);
        if (!targetId) return browserReconciliation('uncertain', 'Tab-close reconciliation requires targetId.');
        const exists = (await this.#listTargets(context.signal)).some((item) => item.id === targetId);
        return exists
          ? browserReconciliation('not_applied', 'The exact browser target still exists.')
          : browserReconciled(action, this.name, 'Fresh target discovery proves the requested browser target is closed.', { targetId, closed: true });
      }

      if (action.capability === 'browser.tab.focus') {
        const targetId = optionalTargetId(action.input.targetId);
        if (!targetId) return browserReconciliation('uncertain', 'Tab-focus reconciliation requires targetId.');
        const tabs = await this.#listTargets(context.signal);
        const target = tabs.find((item) => item.id === targetId);
        if (!target) return browserReconciliation('uncertain', 'Focused target no longer exists.');
        const session = this.#sessions.get(target);
        const evaluated = await session.send('Runtime.evaluate', {
          expression: '({visible: document.visibilityState === "visible", focused: document.hasFocus() === true})',
          returnByValue: true
        });
        const observed = unwrapRuntimeValue(evaluated);
        return browserFocusActuallyProven(observed)
          ? browserReconciled(action, this.name, 'Target document is both visible and actually keyboard-focused.', { targetId, focused: true, visible: true })
          : browserReconciliation('uncertain', 'Visibility alone cannot prove browser tab focus; the current document did not prove both conditions.');
      }

      if (action.capability === 'browser.interact') {
        if (action.input.operation === 'dialog_accept' || action.input.operation === 'dialog_dismiss') {
          const dialogAction = normalizeBrowserDialogAction(action.input);
          const tabs = await this.#listTargets(context.signal);
          const target = requireTarget(tabs, dialogAction.targetId);
          const session = this.#sessions.get(target);
          const watch = await this.#ensureDialogWatch(target, session, context.signal);
          if (watch.current?.ref === dialogAction.dialogRef) {
            return browserReconciliation('not_applied', 'The exact observed JavaScript dialog is still open; no successful handling outcome is claimed.');
          }
          return browserReconciliation('uncertain', 'The exact observed JavaScript dialog is no longer open; absence alone cannot prove which actor or outcome closed it. Do not replay without a fresh observation.');
        }
        const targetId = optionalTargetId(action.input.targetId);
        const expect = action.input.expect;
        if (!targetId || !expect || typeof expect !== 'object' || Array.isArray(expect)) {
          return browserReconciliation('uncertain', 'Generic browser interaction has no explicit post-state verification contract.');
        }
        const verificationAction: ActionRequest = {
          id: `${action.id}:reconcile`,
          capability: 'browser.verify',
          risk: 'read',
          input: {
            targetId,
            ...(action.input.target !== undefined ? { target: action.input.target } : {}),
            expect
          },
          provenance: { kind: 'runtime', source: 'provider-reconciliation' },
          ...(action.taskId ? { taskId: action.taskId } : {}),
          ...(action.intent ? { intent: action.intent } : {})
        };
        const verification = await this.execute(verificationAction, context);
        if (!browserVerificationProven(verification)) {
          return browserReconciliation('uncertain', 'Browser verification returned no fresh VERIFIED result with passing postcondition checks; the side effect remains uncertain.');
        }
        return browserReconciled(action, this.name, 'Explicit browser verification proves the interaction post-state.', {
          targetId,
          verification: verification.output ?? null
        }, verification.evidence);
      }

      return browserReconciliation('uncertain', 'Browser provider has no reconciliation contract for this capability.');
    } catch (error) {
      return browserReconciliation('uncertain', error instanceof Error ? error.message : 'Browser reconciliation failed.');
    }
  }

  async #inspect(action: ActionRequest, started: number, signal?: AbortSignal): Promise<ActionResult> {
    const targetId = optionalTargetId(action.input.targetId);
    const tabs = await this.#listTargets(signal);
    if (!targetId) {
      return {
        ok: true,
        capability: action.capability,
        provider: this.name,
        output: { endpoint: this.#endpoint.origin, tabs: tabs.map(compactTab) },
        evidence: [evidence('browser_state', 'pass', 'Browser tabs inspected through the Chrome DevTools Protocol endpoint.', { tabCount: tabs.length })],
        durationMs: Math.round(performance.now() - started)
      };
    }

    const target = requireTarget(tabs, targetId);
    const session = this.#sessions.get(target);
    const observation = normalizeObservationOptions(action.input.observation);
    const dialogWatch = await this.#ensureDialogWatch(target, session, signal);
    if (dialogWatch.current) {
      return {
        ok: true,
        capability: action.capability,
        provider: this.name,
        output: { target: compactTab(target), dialog: dialogWatch.current },
        evidence: [
          evidence('browser_javascript_dialog', 'pass', 'Observed an exact target/session-bound JavaScript dialog without exporting its message contents.', {
            targetId, dialogRef: dialogWatch.current.ref, type: dialogWatch.current.type,
            messageDigest: dialogWatch.current.messageDigest
          }),
          evidence('data_minimization', 'pass', 'Dialog message and default prompt contents were withheld; only digest, length and bounded origin metadata were returned.')
        ],
        durationMs: Math.round(performance.now() - started)
      };
    }
    throwIfAborted(signal);
    const [mainPage, frameInspection] = await Promise.all([
      inspectPage(session, observation),
      inspectOopifFrames(session, signal, observation)
    ]);
    throwIfAborted(signal);
    const frames = frameInspection.frames;
    const page = { ...mainPage, frames, frameCoverage: frameInspection.degradedReason ? { status: 'degraded', reason: frameInspection.degradedReason } : { status: 'complete' } };
    const bounded = boundBrowserInspectOutput({ target: compactTab(target), page }, observation.maxBytes);
    return {
      ok: true,
      capability: action.capability,
      provider: this.name,
      output: bounded.output,
      evidence: [
        evidence('browser_state', 'pass', 'Semantic page state inspected through CDP across the main document, open shadow roots, same-origin frames, and bounded attached cross-origin frame targets.', { targetId, oopifFrames: frames.length }),
        evidence('data_minimization', 'pass', 'Returned bounded accessibility/DOM summaries instead of raw page HTML.', { accessibilityNodes: page.accessibility.length, oopifFrames: frames.length, returnedBytes: bounded.returnedBytes, truncated: bounded.truncated })
      ],
      durationMs: Math.round(performance.now() - started)
    };
  }

  async #navigate(action: ActionRequest, started: number, signal?: AbortSignal): Promise<ActionResult> {
    const url = validateNavigationUrl(action.input.url);
    if (action.input.newTab !== undefined && typeof action.input.newTab !== 'boolean') {
      throw new OperatorError('INVALID_BROWSER_TAB_MODE', 'newTab must be an exact Boolean.');
    }
    const newTab = action.input.newTab === true;
    const requestedTargetId = optionalTargetId(action.input.targetId);
    if (newTab && requestedTargetId) {
      throw new OperatorError('INVALID_BROWSER_TAB_MODE', 'newTab cannot refer to an existing targetId.');
    }

    let target: CdpTarget;
    if (newTab) {
      target = await this.#createTarget(url, signal);
    } else {
      const tabs = await this.#listTargets(signal);
      target = requestedTargetId ? requireTarget(tabs, requestedTargetId) : requirePageTarget(tabs);
    }

    const session = this.#sessions.get(target);
    const diagnostics = await collectDiagnostics(session);
    try {
      await session.send('Page.enable');
      await session.send('Runtime.enable');
      if (!newTab) {
        const result = await session.send('Page.navigate', { url });
        if (typeof result.errorText === 'string' && result.errorText) {
          throw new OperatorError('BROWSER_NAVIGATION_FAILED', result.errorText, { retryable: true });
        }
      }
      const readiness = await waitForDestinationReady(session, url, 10_000, signal);
      throwIfAborted(signal);
      const state = readiness.state;
      if (!sameDestination(state.url, url)) {
        throw new OperatorError('BROWSER_POSTCONDITION_FAILED', 'Browser did not reach the requested destination.', { retryable: true, details: { requested: url, actual: state.url } });
      }
      return {
        ok: true,
        capability: action.capability,
        provider: this.name,
        output: { targetId: target.id, requestedUrl: url, ...state, readiness: { firstObservedUrl: readiness.firstObservedUrl, polls: readiness.polls, elapsedMs: readiness.elapsedMs }, diagnostics: diagnostics.snapshot() },
        evidence: [
          evidence('browser_navigation', 'pass', 'Browser navigation completed through CDP.', { targetId: target.id, requestedUrl: url }),
          evidence('postcondition', 'pass', 'Active target URL matches the requested destination.', { actualUrl: state.url, title: state.title })
        ],
        durationMs: Math.round(performance.now() - started)
      };
    } finally {
      diagnostics.stop();
    }
  }

  async #focusTab(action: ActionRequest, started: number, signal?: AbortSignal): Promise<ActionResult> {
    const targetId = requiredTargetId(action.input.targetId);
    const tabs = await this.#listTargets(signal);
    const target = requireTarget(tabs, targetId);
    const response = await fetch(new URL(`/json/activate/${encodeURIComponent(targetId)}`, this.#endpoint), {
      redirect: 'error',
      signal: combinedSignal(signal, 3_000)
    });
    if (!response.ok) throw new OperatorError('CDP_ACTIVATE_TAB_FAILED', `CDP returned HTTP ${response.status} while focusing a tab.`, { retryable: true });
    const session = this.#sessions.get(target);
    const result = await session.send('Runtime.evaluate', {
      expression: '({visible: document.visibilityState === "visible", focused: document.hasFocus() === true})',
      returnByValue: true
    });
    const observedFocus = unwrapRuntimeValue(result);
    throwIfAborted(signal);
    if (!browserFocusActuallyProven(observedFocus)) {
      throw new OperatorError('BROWSER_POSTCONDITION_FAILED',
        'Tab activation was dispatched but document visibility and keyboard focus were not both proven.', {
          retryable: false,
          details: {
            executionPhase: 'effect_observed',
            sideEffectState: 'uncertain',
            targetId,
            remedy: 'reobserve_tab_focus_before_retry'
          }
        });
    }
    return {
      ok: true,
      capability: action.capability,
      provider: this.name,
      output: { targetId, visibilityState: 'visible', focused: true },
      evidence: [
        evidence('browser_tab_focus', 'pass', 'Browser target activation command completed.', { targetId }),
        evidence('postcondition', 'pass', 'Target document was freshly observed both visible and keyboard-focused after activation.', { targetId, visible: true, focused: true })
      ],
      durationMs: Math.round(performance.now() - started)
    };
  }

  async #closeTab(action: ActionRequest, started: number, signal?: AbortSignal): Promise<ActionResult> {
    const targetId = requiredTargetId(action.input.targetId);
    requireTarget(await this.#listTargets(signal), targetId);
    const response = await fetch(new URL(`/json/close/${encodeURIComponent(targetId)}`, this.#endpoint), {
      redirect: 'error',
      signal: combinedSignal(signal, 3_000)
    });
    if (!response.ok) throw new OperatorError('CDP_CLOSE_TAB_FAILED', `CDP returned HTTP ${response.status} while closing a tab.`, { retryable: true });
    this.#sessions.forget(targetId);
    const remaining = await this.#listTargets(signal);
    if (remaining.some((item) => item.id === targetId)) {
      throw new OperatorError('BROWSER_POSTCONDITION_FAILED',
        'Tab close command completed but target is still present; a repeat close is not authorized without reconciliation.', {
          retryable: false,
          details: { targetId, sideEffectState: 'uncertain', executionPhase: 'effect_observed', remedy: 'reobserve_before_retry' }
        });
    }
    return {
      ok: true,
      capability: action.capability,
      provider: this.name,
      output: { targetId, closed: true },
      evidence: [
        evidence('browser_tab_close', 'pass', 'Browser target close command completed.', { targetId }),
        evidence('postcondition', 'pass', 'Closed target is absent from browser discovery state.', { targetId })
      ],
      durationMs: Math.round(performance.now() - started)
    };
  }

  async #verify(action: ActionRequest, started: number, signal?: AbortSignal): Promise<ActionResult> {
    const targetId = requiredTargetId(action.input.targetId);
    const rawExpect = normalizeBrowserVerificationExpectations(action.input.expect);
    const targetProvided = action.input.target && typeof action.input.target === 'object' && !Array.isArray(action.input.target);
    const targetSpec = targetProvided ? normalizeTargetSpec(action.input.target) : undefined;
    if (targetSpec && !targetSpec.ref && !targetSpec.css && !targetSpec.text && !targetSpec.renderedColor && !(targetSpec.role && targetSpec.name)) {
      throw new OperatorError('INVALID_BROWSER_TARGET', 'Verification target must use an observed ref, css, text, renderedColor, or role+name.');
    }
    const tabs = await this.#listTargets(signal);
    const target = requireTarget(tabs, targetId);
    const session = this.#sessions.get(target);
    await session.send('Runtime.enable');
    const page = await pageIdentity(session);
    const checks: Array<{ field: string; expected: unknown; actual: unknown; pass: boolean }> = [];
    let inconclusive = false;
    const contains = (actual: string, expected: unknown) => actual.toLowerCase().includes(String(expected ?? '').toLowerCase());

    if (rawExpect.urlContains !== undefined) checks.push({ field: 'urlContains', expected: rawExpect.urlContains, actual: page.url, pass: contains(page.url, rawExpect.urlContains) });
    if (rawExpect.titleContains !== undefined) checks.push({ field: 'titleContains', expected: rawExpect.titleContains, actual: page.title, pass: contains(page.title, rawExpect.titleContains) });
    if (rawExpect.textContains !== undefined) {
      const observation = normalizeObservationOptions({ maxControls: 80, maxText: 160, maxVisuals: 60, maxBytes: 48 * 1024 });
      const [main, childFrames] = await Promise.all([inspectPage(session, observation), inspectOopifFrames(session, signal, observation)]);
      const visibleCorpus = boundedObservationCorpus([main.semantic, ...childFrames.frames.map((frame) => frame.semantic)]);
      checks.push({ field: 'textContains', expected: rawExpect.textContains, actual: visibleCorpus.slice(0, 2000), pass: contains(visibleCorpus, rawExpect.textContains) });
    }

    const targetFields = ['exists', 'value', 'checked', 'selected', 'expanded', 'current', 'active'];
    if (targetFields.some((key) => rawExpect[key] !== undefined)) {
      if (!targetSpec) throw new OperatorError('INVALID_BROWSER_VERIFICATION', 'Target-state expectations require a semantic browser target.');
      const observed = await observeSemanticTargetState(session, targetSpec, signal);
      if (observed.status === 'ambiguous') {
        inconclusive = true;
        checks.push({ field: 'target', expected: 'unique', actual: 'ambiguous', pass: false });
      } else if (observed.status === 'stale') {
        checks.push(...absentBrowserTargetChecks(rawExpect));
      } else {
        const sample = observed.sample ?? {};
        if (rawExpect.exists !== undefined) checks.push({ field: 'exists', expected: Boolean(rawExpect.exists), actual: true, pass: Boolean(rawExpect.exists) });
        for (const field of ['value', 'checked', 'selected', 'expanded', 'current', 'active']) {
          if (rawExpect[field] === undefined) continue;
          checks.push({ field, expected: rawExpect[field], actual: sample[field], pass: sample[field] === rawExpect[field] });
        }
      }
    }

    const allPass = checks.length > 0 && checks.every((check) => check.pass);
    const status = inconclusive ? 'INCONCLUSIVE' : allPass ? 'VERIFIED' : 'NOT_COMPLETE';
    return {
      ok: true,
      capability: action.capability,
      provider: this.name,
      output: { targetId, status, page, checks },
      evidence: [evidence('browser_goal_verification', status === 'VERIFIED' ? 'pass' : 'info', status === 'VERIFIED'
        ? 'Visible browser state satisfies all requested bounded postconditions.'
        : status === 'NOT_COMPLETE'
          ? 'Visible browser state does not yet satisfy all requested bounded postconditions.'
          : 'Browser verification is inconclusive because the observed target is ambiguous.', { targetId, status, checks })],
      durationMs: Math.round(performance.now() - started)
    };
  }

  async #interact(action: ActionRequest, started: number, signal?: AbortSignal): Promise<ActionResult> {
    const operation = typeof action.input.operation === 'string' ? action.input.operation : '';
    if (operation === 'dialog_accept' || operation === 'dialog_dismiss') {
      return await this.#handleDialog(action, started, signal);
    }
    const targetId = requiredTargetId(action.input.targetId);
    if (!['click', 'hover', 'drag', 'drag_by', 'resize', 'drag_between', 'click_relative', 'scroll', 'type', 'select', 'set_value', 'select_date', 'key_press', 'hotkey', 'keyboard_text', 'format_text', 'select_text_range'].includes(operation)) throw new OperatorError('INVALID_BROWSER_OPERATION', 'operation is not a supported bounded browser interaction.');

    const targetSpec = normalizeTargetSpec(action.input.target);
    if (!targetSpec.ref && !targetSpec.css && !targetSpec.text && !targetSpec.renderedColor && !(targetSpec.role && targetSpec.name)) {
      throw new OperatorError('INVALID_BROWSER_TARGET', 'Provide an observed ref, css, text, renderedColor, or role+name for semantic targeting.');
    }
    const toTargetSpec = operation === 'drag_between' ? normalizeTargetSpec(action.input.toTarget) : undefined;
    if (operation === 'drag_between' && (!targetSpec.ref || !toTargetSpec?.ref ||
        !dragRefsShareGeneration(targetSpec.ref, toTargetSpec.ref))) {
      throw new OperatorError('INVALID_BROWSER_TARGET', 'drag_between requires distinct source/destination refs from one current observation generation.');
    }
    const deltaOperation = ['drag', 'drag_by', 'resize', 'scroll'].includes(operation);
    const deltaX = deltaOperation ? exactDelta(action.input.deltaX) : undefined;
    const deltaY = deltaOperation ? exactDelta(action.input.deltaY) : undefined;
    if (deltaOperation && (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || Math.abs(deltaX!) > 2000 || Math.abs(deltaY!) > 2000 || (deltaX === 0 && deltaY === 0))) {
      throw new OperatorError(operation === 'scroll' ? 'INVALID_BROWSER_SCROLL' : 'INVALID_BROWSER_DRAG', 'Drag/resize/scroll requires non-zero finite deltaX/deltaY within 2000 CSS pixels.');
    }
    if (operation === 'scroll' && !targetSpec.ref) throw new OperatorError('INVALID_BROWSER_TARGET', 'scroll requires an observed target ref.');
    if (operation === 'resize' && !targetSpec.ref) throw new OperatorError('INVALID_BROWSER_TARGET', 'resize requires an observed semantic target ref.');
    if (operation === 'format_text') {
      const format = typeof action.input.value === 'string' ? action.input.value.toLowerCase() : '';
      const formatScope = action.input.scope === undefined ? 'all' : typeof action.input.scope === 'string' ? action.input.scope.toLowerCase() : '';
      if (!targetSpec.ref) throw new OperatorError('INVALID_BROWSER_TARGET', 'format_text requires an observed editable target ref.');
      if (!['bold', 'italic', 'italics', 'underline', 'underlined'].includes(format) || !['all', 'selection'].includes(formatScope)) {
        throw new OperatorError('INVALID_BROWSER_FORMAT', 'format_text supports bold, italic, or underline with scope all or selection.');
      }
    }
    if (operation === 'keyboard_text') {
      const text = typeof action.input.value === 'string' ? action.input.value : '';
      if (!targetSpec.ref) throw new OperatorError('INVALID_BROWSER_TARGET', 'keyboard_text requires an observed target ref.');
      if (!text.length || text.length > 4096 || Buffer.byteLength(text, 'utf8') > 16 * 1024) throw new OperatorError('INVALID_BROWSER_TEXT', 'keyboard_text requires 1-4096 characters and at most 16 KiB UTF-8.');
    }
    if (operation === 'select_date') {
      const requestedDate = typeof action.input.value === 'string' ? action.input.value : '';
      if (!targetSpec.ref) throw new OperatorError('INVALID_BROWSER_TARGET', 'select_date requires an observed target ref.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) throw new OperatorError('INVALID_BROWSER_DATE', 'select_date requires an ISO YYYY-MM-DD value.');
    }
    const hasRatioPoint = operation === 'click_relative' && (action.input.xRatio !== undefined || action.input.yRatio !== undefined);
    const hasPixelPoint = operation === 'click_relative' && (action.input.xPx !== undefined || action.input.yPx !== undefined);
    const xRatio = hasRatioPoint ? optionalCoordinate(action.input.xRatio) : undefined;
    const yRatio = hasRatioPoint ? optionalCoordinate(action.input.yRatio) : undefined;
    const xPx = hasPixelPoint ? optionalCoordinate(action.input.xPx) : undefined;
    const yPx = hasPixelPoint ? optionalCoordinate(action.input.yPx) : undefined;
    if (operation === 'click_relative' && (
      !targetSpec.ref || hasRatioPoint === hasPixelPoint
      || (hasRatioPoint && (!Number.isFinite(xRatio) || !Number.isFinite(yRatio) || xRatio! < 0 || xRatio! > 1 || yRatio! < 0 || yRatio! > 1))
      || (hasPixelPoint && (!Number.isFinite(xPx) || !Number.isFinite(yPx) || xPx! < 0 || yPx! < 0 || xPx! > 2000 || yPx! > 2000))
    )) {
      throw new OperatorError('INVALID_BROWSER_POINT', 'click_relative requires an observed ref and exactly one bounded coordinate pair: xRatio/yRatio in [0,1] or non-negative xPx/yPx within 2000 CSS pixels.');
    }

    // Validate every key/range/download parameter before establishing CDP
    // sessions or evaluating a page. Object/array coercion must never generate
    // an authorized keyboard gesture or change the download accounting window.
    if (action.input.expectDownload !== undefined && typeof action.input.expectDownload !== 'boolean') {
      throw new OperatorError('INVALID_DOWNLOAD_INTERACTION', 'expectDownload must be an exact Boolean.');
    }
    // A tab ID is not a site permission: an approved download must be bound
    // to the exact declared HTTP(S) origin at the moment of interaction.
    if (action.input.expectDownload === true) {
      const approvedOrigin = action.input.expectedOrigin;
      if (typeof approvedOrigin !== 'string') {
        throw new OperatorError('BROWSER_DOWNLOAD_ORIGIN_DENIED', 'Download requires an exact approved browser origin.');
      }
      let checked: URL;
      try { checked = new URL(approvedOrigin); }
      catch { throw new OperatorError('BROWSER_DOWNLOAD_ORIGIN_DENIED', 'Download origin is not a valid URL.'); }
      if (!['http:', 'https:'].includes(checked.protocol) || checked.origin !== approvedOrigin
          || checked.username || checked.password) {
        throw new OperatorError('BROWSER_DOWNLOAD_ORIGIN_DENIED', 'Download origin must be a canonical approved HTTP(S) origin.');
      }
    } else if (action.input.expectedOrigin !== undefined) {
      throw new OperatorError('INVALID_DOWNLOAD_INTERACTION', 'expectedOrigin is only valid for an expected browser download.');
    }
    if (action.input.downloadTimeoutMs !== undefined &&
        (typeof action.input.downloadTimeoutMs !== 'number' ||
         !Number.isSafeInteger(action.input.downloadTimeoutMs) ||
         action.input.downloadTimeoutMs < 1_000 || action.input.downloadTimeoutMs > 600_000)) {
      throw new OperatorError('INVALID_DOWNLOAD_TIMEOUT', 'downloadTimeoutMs must be an exact integer from 1000 to 600000.');
    }
    if (operation === 'key_press' &&
        (typeof action.input.key !== 'string' || !action.input.key.trim() ||
         action.input.key.length > 64 || action.input.key.includes('\0'))) {
      throw new OperatorError('INVALID_BROWSER_KEY', 'key_press requires an exact bounded key string.');
    }
    if (operation === 'hotkey' &&
        (!Array.isArray(action.input.keys) || action.input.keys.length < 1 ||
         action.input.keys.length > 4 ||
         action.input.keys.some(key => typeof key !== 'string' || !key.trim() ||
           key.length > 64 || key.includes('\0')))) {
      throw new OperatorError('INVALID_BROWSER_HOTKEY', 'hotkey requires 1-4 exact bounded key names.');
    }
    if (operation === 'select_text_range' &&
        (typeof action.input.start !== 'number' ||
         typeof action.input.end !== 'number' ||
         !Number.isSafeInteger(action.input.start) ||
         !Number.isSafeInteger(action.input.end) ||
         action.input.start < 0 || action.input.end < action.input.start ||
         action.input.end > 1_000_000)) {
      throw new OperatorError('INVALID_BROWSER_TEXT_RANGE', 'Text range must use 0-based bounded exact integers, start <= end.');
    }
    const tabs = await this.#listTargets(signal);
    const target = requireTarget(tabs, targetId);
    const session = this.#sessions.get(target);
    const diagnostics = await collectDiagnostics(session);
    const expectDownload = action.input.expectDownload === true;
    let download: DownloadTracker | undefined;
    let interactionDispatched = false;
    try {
      await session.send('Runtime.enable');
      if (expectDownload) {
        if (operation !== 'click') throw new OperatorError('INVALID_DOWNLOAD_INTERACTION', 'expectDownload is only valid for click operations.');
        const frameTree = await session.send('Page.getFrameTree');
        const frameIds = collectFrameIds(frameTree.frameTree);
        if (frameIds.size === 0) throw new OperatorError('BROWSER_DOWNLOAD_CORRELATION_UNAVAILABLE', 'The initiating target did not expose a frame identity for download correlation.');
        download = await this.#prepareDownload(
          (action.input.downloadTimeoutMs as number | undefined) ?? 30_000,
          targetId,
          frameIds,
          signal
        );
      }
      const before = await pageIdentity(session);
      if (expectDownload) {
        const approved = action.input.expectedOrigin as string;
        let activeOrigin = '';
        let observedOrigin = '';
        try { activeOrigin = new URL(target.url ?? '').origin; } catch { /* No confirmed site identity. */ }
        try { observedOrigin = new URL(before.url).origin; } catch { /* No confirmed document identity. */ }
        if (activeOrigin !== approved || observedOrigin !== approved) {
          throw new OperatorError('BROWSER_DOWNLOAD_ORIGIN_DENIED',
            'The exact initiating tab and freshly observed page must remain inside the approved download origin.');
        }
      }
      const interaction = await performSemanticInteraction(session, {
        operation,
        target: targetSpec,
        ...(toTargetSpec ? { toTarget: toTargetSpec } : {}),
        value: action.input.value ?? null,
        ...(operation === 'format_text' ? { scope: (action.input.scope as string | undefined) ?? 'all' } : {}),
        ...(deltaOperation ? { deltaX, deltaY } : {}),
        ...(operation === 'click_relative' && hasRatioPoint ? { xRatio, yRatio } : {}),
        ...(operation === 'click_relative' && hasPixelPoint ? { xPx, yPx } : {}),
        ...(operation === 'key_press' ? { key: action.input.key as string } : {}),
        ...(operation === 'hotkey' ? { keys: action.input.keys as string[] } : {}),
        ...(operation === 'select_text_range' ? { start: action.input.start as number, end: action.input.end as number } : {})
      }, signal);
      const value = interaction.value;
      if (value.ok !== true) {
        const message = typeof value.error === 'string' ? String(value.error) : 'Browser interaction did not complete.';
        if (value.recoverable === true) {
          throw new OperatorError('BROWSER_INPUT_NORMALIZATION_REQUIRED', message, {
            retryable: true,
            details: { target: targetSpec, frame: interaction.frame, sideEffectState: 'none', executionPhase: 'pre_dispatch' }
          });
        }
        if (value.staleRef === true || (targetSpec.ref && /stale/i.test(message))) {
          throw new OperatorError('BROWSER_TARGET_STALE', message, { retryable: true, details: { target: targetSpec, frame: interaction.frame } });
        }
        throw new OperatorError('BROWSER_INTERACTION_FAILED', message, { retryable: false, details: { target: targetSpec, frame: interaction.frame } });
      }
      interactionDispatched = true;
      const matchedAutocomplete = Boolean(value.matched && typeof value.matched === 'object' && (value.matched as JsonMap).autocomplete === true);
      const settle = await settleAfterInteraction(session, signal, operation === 'type' && matchedAutocomplete ? 350 : 50);
      throwIfAborted(signal);
      const after = await pageIdentity(session);
      const afterTarget = await observeSemanticTargetState(session, targetSpec, signal);
      const afterDestination = toTargetSpec ? await observeSemanticTargetState(session, toTargetSpec, signal) : undefined;
      const beforeTarget = value.matched && typeof value.matched === 'object' ? value.matched as JsonMap : {};
      const beforeDestination = value.destination && typeof value.destination === 'object' ? value.destination as JsonMap : undefined;
      const compactTarget = (sample: JsonMap | undefined) => sample ? {
        identity: sample.identity, role: sample.role, name: sample.name, value: sample.value,
        checked: sample.checked, selected: sample.selected, expanded: sample.expanded, current: sample.current,
        active: sample.active, scroll: sample.scroll, geometry: sample.geometry, localTreeState: sample.subtreeSignature,
        associatedState: sample.associatedState
      } : null;
      const beforeRelevant = { page: { url: before.url, title: before.title }, target: compactTarget(beforeTarget), ...(beforeDestination ? { destination: compactTarget(beforeDestination) } : {}) };
      const afterRelevant = {
        page: { url: after.url, title: after.title },
        target: afterTarget.status === 'observed' ? compactTarget(afterTarget.sample) : { status: afterTarget.status },
        ...(afterDestination ? { destination: afterDestination.status === 'observed' ? compactTarget(afterDestination.sample) : { status: afterDestination.status } } : {})
      };
      const semanticAfter = value.after && typeof value.after === 'object' ? value.after as JsonMap : undefined;
      const directSemanticProgress = ['type', 'select', 'set_value', 'select_date', 'select_text_range'].includes(operation)
        && semanticAfter !== undefined
        && JSON.stringify({
          value: beforeTarget.value, checked: beforeTarget.checked, selected: beforeTarget.selected,
          selection: (beforeTarget as JsonMap).selection
        }) !== JSON.stringify({
          value: semanticAfter.value, checked: semanticAfter.checked, selected: semanticAfter.selected,
          selection: semanticAfter.selection
        });
      const rawDownloadResult = download ? await download.done : undefined;
      // CDP events may contain absolute local paths or token-bearing download
      // URLs. Hash locally, then remove those fields before writing any
      // durable ActionResult, evidence, diagnostic or user-visible response.
      const boundDownload = rawDownloadResult
        ? await bindCompletedDownloadArtifact(rawDownloadResult, targetId, targetSpec, signal)
        : undefined;
      const downloadResult = boundDownload ? { ...boundDownload } : undefined;
      if (downloadResult) {
        delete downloadResult.filePath;
        delete downloadResult.url;
      }
      if (downloadResult?.state === 'canceled') {
        throw new OperatorError('BROWSER_DOWNLOAD_CANCELED', 'Browser download was canceled.', { retryable: true, details: downloadResult });
      }
      const stateProgress = downloadResult?.state === 'completed' || directSemanticProgress || JSON.stringify(beforeRelevant) !== JSON.stringify(afterRelevant);
      if (['drag', 'drag_by', 'drag_between'].includes(operation) && !stateProgress) {
        // An unobserved page delta does not prove no physical effect: a drag
        // was dispatched and may have changed hidden server or application state.
        // Never mark it side-effect-free or permit blind replay.
        throw new OperatorError('BROWSER_NO_PROGRESS', 'Drag input was dispatched but no source, destination, or associated objective state changed.', {
          retryable: false,
          details: { sideEffectState: 'uncertain', executionPhase: 'effect_observed', actionFamily: 'drag', target: targetSpec, toTarget: toTargetSpec, before: beforeRelevant, after: afterRelevant }
        });
      }
      const actionIdentity = String(beforeTarget.identity ?? targetSpec.ref ?? targetSpec.css ?? `${targetSpec.role ?? ''}:${targetSpec.name ?? targetSpec.text ?? ''}`);
      const actionPayload = { operation, toTarget: toTargetSpec, value: action.input.value ?? null, deltaX, deltaY, xRatio, yRatio, xPx, yPx, key: action.input.key, keys: action.input.keys, start: action.input.start, end: action.input.end };
      const noProgressFamily = (() => {
        if (operation === 'drag' || operation === 'drag_by') return { family: 'drag-displacement' };
        if (operation === 'resize') return { family: 'resize-displacement' };
        if (operation === 'scroll') return { family: 'scroll' };
        if (operation === 'drag_between') return { family: 'drag-between', toTarget: toTargetSpec };
        if (operation === 'click_relative') return { family: 'click-relative' };
        if (operation === 'key_press') return { family: 'key-press', key: action.input.key };
        if (operation === 'hotkey') return { family: 'hotkey', keys: action.input.keys };
        if (operation === 'type' || operation === 'select' || operation === 'set_value' || operation === 'select_date' || operation === 'keyboard_text' || operation === 'format_text') return { family: operation, value: action.input.value ?? null, ...(operation === 'format_text' ? { scope: action.input.scope ?? 'all' } : {}) };
        if (operation === 'select_text_range') return { family: operation, start: action.input.start, end: action.input.end };
        return { family: operation };
      })();
      const noProgressKey = JSON.stringify({ targetId, actionIdentity, beforeRelevant, noProgressFamily });
      let repeatedNoProgress = 0;
      if (operation !== 'hover' && !stateProgress) {
        repeatedNoProgress = (this.#noProgressHistory.get(noProgressKey) ?? 0) + 1;
        this.#noProgressHistory.set(noProgressKey, repeatedNoProgress);
        if (this.#noProgressHistory.size > 256) this.#noProgressHistory.delete(this.#noProgressHistory.keys().next().value as string);
        if (repeatedNoProgress >= 2) {
          this.#noProgressPrevented += 1;
          throw new OperatorError('BROWSER_NO_PROGRESS', 'The same browser action produced no meaningful state delta twice; re-observe and change strategy instead of repeating it.', {
            retryable: false,
            details: { sideEffectState: 'uncertain', executionPhase: 'effect_observed', repeatedAction: actionPayload, actionFamily: noProgressFamily, target: targetSpec, before: beforeRelevant, after: afterRelevant, repeatedNoProgress, preventedCount: this.#noProgressPrevented }
          });
        }
      } else if (stateProgress) {
        this.#noProgressHistory.delete(noProgressKey);
      }
      const stateDelta = { progress: stateProgress, repeatedNoProgress, before: beforeRelevant, after: afterRelevant, preventedCount: this.#noProgressPrevented };
      const evidenceItems = [
        evidence('browser_interaction', 'pass', `Semantic browser ${operation} executed through CDP after a unique cross-context locate preflight.`, { targetId, matched: value.matched, frame: interaction.frame }),
        evidence('postcondition', 'pass', 'Element and page state were re-read after the interaction.', { after: value.after, pageUrl: after.url, frame: interaction.frame, stateDelta }),
        evidence('browser_state_delta', stateProgress ? 'pass' : 'info', stateProgress ? 'Browser interaction produced a meaningful bounded state delta.' : 'Browser interaction produced no meaningful bounded state delta; one equivalent retry remains before forced replanning.', { stateDelta })
      ];
      if (downloadResult) evidenceItems.push(evidence('download_complete', 'pass', 'Browser emitted a completed download event.', downloadResult));
      return {
        ok: true,
        capability: action.capability,
        provider: this.name,
        output: { targetId, operation, matched: value.matched, ...(interaction.frame ? { frame: interaction.frame } : {}), before, after, settle, stateDelta, ...(downloadResult ? { download: downloadResult } : {}), diagnostics: diagnostics.snapshot() },
        evidence: evidenceItems,
        durationMs: Math.round(performance.now() - started)
      };
    } catch (error) {
      if (interactionDispatched && error instanceof OperatorError
        && error.details?.executionPhase === undefined && error.details?.sideEffectState === undefined) {
        throw new OperatorError(error.code, error.message, {
          retryable: error.retryable,
          details: { ...(error.details ?? {}), sideEffectState: 'uncertain', executionPhase: 'dispatched' }
        });
      }
      if (interactionDispatched && !(error instanceof OperatorError)) {
        throw new OperatorError('BROWSER_POST_DISPATCH_FAILED', error instanceof Error ? error.message : String(error), {
          retryable: true,
          details: { sideEffectState: 'uncertain', executionPhase: 'dispatched' }
        });
      }
      throw error;
    } finally {
      diagnostics.stop();
      download?.stop();
    }
  }

  async #ensureDialogWatch(target: CdpTarget, session: CdpConnection, signal?: AbortSignal): Promise<BrowserDialogWatch> {
    let watch = this.#dialogWatches.get(target.id);
    if (watch?.session !== session) {
      watch?.stop();
      const created: BrowserDialogWatch = {
        targetId: target.id,
        session,
        generation: 0,
        stop: () => undefined
      };
      const offOpening = session.on('Page.javascriptDialogOpening', (params) => {
        try {
          created.current = normalizeJavaScriptDialogObservation({
            params,
            targetId: target.id,
            instanceNonce: this.#dialogInstanceNonce,
            generation: ++created.generation
          });
          created.invalidEvent = false;
        } catch {
          created.current = undefined;
          created.invalidEvent = true;
        }
      });
      const offClosed = session.on('Page.javascriptDialogClosed', (params) => {
        const current = created.current;
        created.current = undefined;
        if (current && typeof params.result === 'boolean') {
          created.lastClosed = {
            ref: current.ref,
            result: params.result,
            observedAt: new Date().toISOString()
          };
        }
      });
      created.stop = () => { offOpening(); offClosed(); };
      watch = created;
      this.#dialogWatches.set(target.id, watch);
    }
    await session.send('Page.enable', {}, 8_000, signal);
    // CDP may enqueue javascriptDialogOpening in the same turn as Page.enable.
    await Promise.resolve();
    if (watch.invalidEvent) {
      throw new OperatorError('BROWSER_DIALOG_EVENT_INVALID', 'Browser reported a malformed JavaScript dialog event; refusing to inspect or handle it.', {
        retryable: false,
        details: { targetId: target.id, remedy: 'close_the_dialog_manually_then_reobserve' }
      });
    }
    return watch;
  }

  #waitForDialogClosure(
    watch: BrowserDialogWatch,
    dialogRef: string,
    signal?: AbortSignal
  ): { promise: Promise<BrowserDialogClosure>; stop(): void } {
    let settled = false;
    let resolveClosure!: (value: BrowserDialogClosure) => void;
    let rejectClosure!: (error: Error) => void;
    const promise = new Promise<BrowserDialogClosure>((resolve, reject) => {
      resolveClosure = resolve;
      rejectClosure = reject;
    });
    void promise.catch(() => undefined);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      offClosed();
      callback();
    };
    const check = () => {
      if (watch.lastClosed?.ref === dialogRef) finish(() => resolveClosure(watch.lastClosed!));
    };
    const offClosed = watch.session.on('Page.javascriptDialogClosed', () => queueMicrotask(check));
    const onAbort = () => finish(() => rejectClosure(abortError()));
    const timer = setTimeout(() => finish(() => rejectClosure(new OperatorError(
      'BROWSER_DIALOG_POSTCONDITION_UNCONFIRMED',
      'Browser did not emit an exact dialog-closed postcondition in time.',
      { retryable: false }
    ))), 2_000);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else queueMicrotask(check);
    return { promise, stop: () => finish(() => rejectClosure(new OperatorError('BROWSER_DIALOG_WAIT_STOPPED', 'Dialog close observation stopped.', { retryable: false }))) };
  }

  async #handleDialog(action: ActionRequest, started: number, signal?: AbortSignal): Promise<ActionResult> {
    const request = normalizeBrowserDialogAction(action.input);
    const target = requireTarget(await this.#listTargets(signal), request.targetId);
    const session = this.#sessions.get(target);
    const watch = await this.#ensureDialogWatch(target, session, signal);
    const current = watch.current;
    if (!current) {
      throw new OperatorError('BROWSER_DIALOG_NOT_FOUND', 'No open JavaScript dialog is observed for the exact browser target.', {
        retryable: true,
        details: { targetId: request.targetId, remedy: 'reobserve_before_retry', sideEffectState: 'none', executionPhase: 'pre_dispatch' }
      });
    }
    if (current.ref !== request.dialogRef) {
      throw new OperatorError('BROWSER_DIALOG_STALE', 'The JavaScript dialog ref is stale or belongs to a different target/session generation.', {
        retryable: true,
        details: { targetId: request.targetId, remedy: 'reobserve_before_retry', sideEffectState: 'none', executionPhase: 'pre_dispatch' }
      });
    }
    if (request.promptText !== undefined && current.type !== 'prompt') {
      throw new OperatorError('INVALID_BROWSER_DIALOG_PROMPT', 'promptText is only valid for an observed prompt dialog.', {
        retryable: false,
        details: { sideEffectState: 'none', executionPhase: 'pre_dispatch' }
      });
    }
    throwIfAborted(signal);
    const accept = request.operation === 'dialog_accept';
    const close = this.#waitForDialogClosure(watch, request.dialogRef, signal);
    let dispatchAttempted = false;
    try {
      dispatchAttempted = true;
      await session.send('Page.handleJavaScriptDialog', {
        accept,
        ...(request.promptText !== undefined ? { promptText: request.promptText } : {})
      }, 8_000, signal);
      const closure = await close.promise;
      if (closure.result !== accept) {
        throw new OperatorError('BROWSER_DIALOG_OUTCOME_MISMATCH', 'The observed dialog closed with a different result than the requested action.', {
          retryable: false,
          details: { targetId: request.targetId, dialogRef: request.dialogRef, expectedAccept: accept,
            observedAccept: closure.result, sideEffectState: 'known', executionPhase: 'effect_observed' }
        });
      }
      return {
        ok: true,
        capability: action.capability,
        provider: this.name,
        output: {
          targetId: request.targetId,
          dialogRef: request.dialogRef,
          dialogType: current.type,
          outcome: accept ? 'accepted' : 'dismissed',
          closedAt: closure.observedAt
        },
        evidence: [
          evidence('browser_javascript_dialog', 'pass', 'Handled the exact target/session-bound JavaScript dialog.', {
            targetId: request.targetId, dialogRef: request.dialogRef, type: current.type, outcome: accept ? 'accepted' : 'dismissed'
          }),
          evidence('postcondition', 'pass', 'CDP emitted the matching dialog-closed result after the requested handling command.', {
            dialogRef: request.dialogRef, accepted: closure.result
          })
        ],
        durationMs: Math.round(performance.now() - started)
      };
    } catch (error) {
      if (!dispatchAttempted) throw error;
      // A proven, known mismatch is already the most specific outcome. Any
      // lower-level transport/cancellation uncertainty still needs the
      // dialog-specific no-replay remedy and target-bound context.
      if (error instanceof OperatorError && error.details?.sideEffectState === 'known') throw error;
      throw new OperatorError('BROWSER_DIALOG_OUTCOME_UNCERTAIN', 'JavaScript dialog handling was dispatched but its exact outcome was not proven; re-observe and do not replay blindly.', {
        retryable: false,
        details: {
          targetId: request.targetId,
          dialogRef: request.dialogRef,
          causeCode: error instanceof OperatorError ? error.code : 'UNKNOWN',
          remedy: 'reobserve_dialog_do_not_retry',
          sideEffectState: 'uncertain',
          executionPhase: 'dispatched'
        }
      });
    } finally {
      close.stop();
    }
  }

  async #browserConnection(signal?: AbortSignal): Promise<CdpConnection> {
    if (this.#browserSession && !this.#browserSession.closed) return this.#browserSession;
    const response = await fetch(new URL('/json/version', this.#endpoint), { redirect: 'error', signal: combinedSignal(signal, 3_000) });
    if (!response.ok) throw new OperatorError('CDP_HTTP_ERROR', `CDP returned HTTP ${response.status} while discovering browser endpoint.`, { retryable: true });
    const version = await boundedDiscoveryJson(response);
    if (!version || typeof version !== 'object' || Array.isArray(version)) {
      throw new OperatorError('CDP_DISCOVERY_INVALID', 'Browser version discovery must return an object.');
    }
    const ws = typeof (version as JsonMap).webSocketDebuggerUrl === 'string' ? String((version as JsonMap).webSocketDebuggerUrl) : '';
    if (!ws) throw new OperatorError('CDP_BROWSER_TARGET_UNAVAILABLE', 'Browser does not expose a browser-level DevTools WebSocket endpoint.', { retryable: true });
    this.#browserSession = new CdpConnection('browser', ws);
    return this.#browserSession;
  }

  async #prepareDownload(timeoutMs: number, targetId: string, allowedFrameIds: Set<string>, signal?: AbortSignal): Promise<DownloadTracker> {
    const browser = await this.#browserConnection(signal);
    await browser.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
    await browser.send('Target.setDiscoverTargets', { discover: true });
    let activeGuid: string | undefined;
    let meta: { url?: string; suggestedFilename?: string } = {};
    let settled = false;
    let resolveDone!: (value: { guid: string; state: string; url?: string; suggestedFilename?: string; receivedBytes?: number; totalBytes?: number; filePath?: string }) => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<{ guid: string; state: string; url?: string; suggestedFilename?: string; receivedBytes?: number; totalBytes?: number; filePath?: string }>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    // The interaction settles before awaiting download completion; attach a
    // handler now so an early ambiguity/cancellation is not process-global.
    void done.catch(() => undefined);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectDone(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        rejectDone(new OperatorError('BROWSER_DOWNLOAD_TIMEOUT', `No completed download event arrived within ${timeoutMs}ms.`, { retryable: true }));
      }
    }, timeoutMs);
    if (signal?.aborted) onAbort();
    const offBegin = browser.on('Browser.downloadWillBegin', (params) => {
      const frameId = typeof params.frameId === 'string' ? params.frameId : '';
      const guid = typeof params.guid === 'string' ? params.guid : '';
      if (!frameId || !allowedFrameIds.has(frameId) || !guid || settled) return;
      if (activeGuid && activeGuid !== guid) {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        rejectDone(new OperatorError('BROWSER_DOWNLOAD_AMBIGUOUS', 'Multiple downloads began in the initiating target; refusing to guess which one belongs to the action.', { retryable: false }));
        return;
      }
      activeGuid = guid;
      meta = {
        url: typeof params.url === 'string' ? params.url.slice(0, 2000) : undefined,
        suggestedFilename: typeof params.suggestedFilename === 'string' ? params.suggestedFilename.slice(0, 500) : undefined
      };
    });
    const offProgress = browser.on('Browser.downloadProgress', (params) => {
      const guid = typeof params.guid === 'string' ? params.guid : '';
      const state = typeof params.state === 'string' ? params.state : '';
      if (!activeGuid || !guid || guid !== activeGuid || !['completed', 'canceled'].includes(state) || settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolveDone({
        guid,
        state,
        ...meta,
        receivedBytes: typeof params.receivedBytes === 'number' ? params.receivedBytes : undefined,
        totalBytes: typeof params.totalBytes === 'number' ? params.totalBytes : undefined,
        filePath: typeof params.filePath === 'string' ? params.filePath.slice(0, 2000) : undefined
      });
    });
    const offDestroyed = browser.on('Target.targetDestroyed', (params) => {
      if (settled || params.targetId !== targetId) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      rejectDone(new OperatorError('BROWSER_DOWNLOAD_TARGET_CLOSED', 'The initiating browser target closed before its download completed.', { retryable: true }));
    });
    return { done, stop: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); offBegin(); offProgress(); offDestroyed(); } };
  }

  async #listTargets(signal?: AbortSignal): Promise<CdpTarget[]> {
    const response = await fetch(new URL('/json/list', this.#endpoint), { redirect: 'error', signal: combinedSignal(signal, 3_000) });
    if (!response.ok) throw new OperatorError('CDP_HTTP_ERROR', `CDP returned HTTP ${response.status}.`, { retryable: true });
    const raw = await boundedDiscoveryJson(response);
    return normalizeCdpTargets(raw);

  }

  async #createTarget(url: string, signal?: AbortSignal): Promise<CdpTarget> {
    const endpoint = new URL('/json/new', this.#endpoint);
    endpoint.search = url;
    const response = await fetch(endpoint, { method: 'PUT', redirect: 'error', signal: combinedSignal(signal, 4_000) });
    if (!response.ok) throw new OperatorError('CDP_CREATE_TAB_FAILED', `CDP returned HTTP ${response.status} while creating a tab.`, { retryable: true });
    const tab = await boundedDiscoveryJson(response) as Record<string, unknown>;
    if (!tab || typeof tab !== 'object' || Array.isArray(tab)) {
      throw new OperatorError('CDP_DISCOVERY_INVALID', 'Browser new-tab discovery must return an object.');
    }
    const target: CdpTarget = {
      id: String(tab.id ?? ''),
      type: typeof tab.type === 'string' ? tab.type : undefined,
      title: typeof tab.title === 'string' ? tab.title : undefined,
      url: typeof tab.url === 'string' ? tab.url : undefined,
      webSocketDebuggerUrl: typeof tab.webSocketDebuggerUrl === 'string' ? tab.webSocketDebuggerUrl : undefined
    };
    if (!target.id) throw new OperatorError('CDP_CREATE_TAB_FAILED', 'Browser returned an invalid new-tab target.', { retryable: true });
    return target;
  }
}

function collectFrameIds(input: unknown, output = new Set<string>()): Set<string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return output;
  const node = input as JsonMap;
  const frame = node.frame && typeof node.frame === 'object' && !Array.isArray(node.frame) ? node.frame as JsonMap : undefined;
  if (typeof frame?.id === 'string' && frame.id.length > 0) output.add(frame.id);
  if (Array.isArray(node.childFrames)) for (const child of node.childFrames.slice(0, 256)) collectFrameIds(child, output);
  return output;
}

export function boundBrowserInspectOutput(output: JsonMap, maxBytes: number): { output: JsonMap; returnedBytes: number; truncated: boolean } {
  const byteLength = () => Buffer.byteLength(JSON.stringify(output), 'utf8');
  const page = output.page && typeof output.page === 'object' && !Array.isArray(output.page) ? output.page as JsonMap : undefined;
  if (!page) return { output, returnedBytes: byteLength(), truncated: false };

  const initialBytes = byteLength();
  let truncated = false;
  const targetBytes = Math.max(1024, maxBytes - 768);

  const semanticScopes = (): JsonMap[] => {
    const scopes: JsonMap[] = [];
    if (page.semantic && typeof page.semantic === 'object' && !Array.isArray(page.semantic)) scopes.push(page.semantic as JsonMap);
    const frames = Array.isArray(page.frames) ? page.frames as JsonMap[] : [];
    for (const frame of frames) {
      if (frame?.semantic && typeof frame.semantic === 'object' && !Array.isArray(frame.semantic)) scopes.push(frame.semantic as JsonMap);
    }
    return scopes;
  };

  const updatePageMeta = (semantic: JsonMap, key: 'controls' | 'visibleText' | 'visualObjects', returned: number) => {
    const pagination = semantic.pagination && typeof semantic.pagination === 'object' && !Array.isArray(semantic.pagination)
      ? semantic.pagination as JsonMap
      : undefined;
    const meta = pagination?.[key] && typeof pagination[key] === 'object' && !Array.isArray(pagination[key])
      ? pagination[key] as JsonMap
      : undefined;
    if (!meta) return;
    const offset = Number(meta.offset ?? 0);
    const total = Number(meta.total ?? returned);
    meta.returned = returned;
    meta.truncated = offset + returned < total;
    if (meta.truncated) meta.nextOffset = offset + returned;
    else delete meta.nextOffset;
  };

  while (byteLength() > targetBytes) {
    const candidates: Array<{ owner: JsonMap; key: string; bytes: number; semantic?: JsonMap; paginationKey?: 'controls' | 'visibleText' | 'visualObjects' }> = [];
    if (Array.isArray(page.accessibility) && page.accessibility.length > 0) {
      candidates.push({ owner: page, key: 'accessibility', bytes: Buffer.byteLength(JSON.stringify(page.accessibility), 'utf8') });
    }
    for (const semantic of semanticScopes()) {
      for (const key of ['controls', 'visibleText', 'visualObjects', 'headings', 'forms'] as const) {
        const value = semantic[key];
        if (Array.isArray(value) && value.length > 0) {
          candidates.push({
            owner: semantic,
            key,
            bytes: Buffer.byteLength(JSON.stringify(value), 'utf8'),
            semantic,
            ...(key === 'controls' || key === 'visibleText' || key === 'visualObjects' ? { paginationKey: key } : {})
          });
        }
      }
    }
    candidates.sort((left, right) => right.bytes - left.bytes);
    const candidate = candidates[0];
    if (!candidate) {
      const frames = Array.isArray(page.frames) ? page.frames as JsonMap[] : [];
      if (frames.length === 0) break;
      const totalFrames = Number((page.frameCoverage as JsonMap | undefined)?.totalFrames ?? frames.length);
      frames.pop();
      page.frameCoverage = { status: 'degraded', reason: 'output_budget', totalFrames, returnedFrames: frames.length };
      truncated = true;
      continue;
    }
    const value = candidate.owner[candidate.key] as unknown[];
    const nextLength = Math.max(0, Math.floor(value.length / 2));
    candidate.owner[candidate.key] = value.slice(0, nextLength);
    if (candidate.key === 'visualObjects' && candidate.semantic) candidate.semantic.visuals = candidate.owner[candidate.key];
    if (candidate.paginationKey && candidate.semantic) updatePageMeta(candidate.semantic, candidate.paginationKey, nextLength);
    if (candidate.key === 'accessibility') {
      if (page.accessibilityTotal === undefined) page.accessibilityTotal = value.length;
      page.accessibilityTruncated = true;
    } else if (!candidate.paginationKey && candidate.semantic) {
      candidate.semantic.summaryTruncated = true;
    }
    truncated = true;
  }

  output.truncated = truncated;
  if (truncated) output.totalBytes = initialBytes;
  output.returnedBytes = 0;
  output.returnedBytes = byteLength();
  output.returnedBytes = byteLength();
  return { output, returnedBytes: Number(output.returnedBytes), truncated };
}

function boundedObservationCorpus(inputs: unknown[]): string {
  const values: string[] = [];
  let used = 0;
  const visit = (value: unknown, depth = 0) => {
    if (used >= 32_000 || depth > 8 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      const bounded = value.slice(0, Math.max(0, Math.min(1000, 32_000 - used)));
      values.push(bounded); used += bounded.length + 1; return;
    }
    if (Array.isArray(value)) { for (const item of value.slice(0, 240)) visit(item, depth + 1); return; }
    if (typeof value !== 'object') return;
    const record = value as JsonMap;
    for (const key of ['text', 'name', 'value', 'placeholder', 'title']) if (typeof record[key] === 'string') visit(record[key], depth + 1);
    for (const key of ['controls', 'visibleText', 'visualObjects', 'headings', 'forms']) if (record[key] !== undefined) visit(record[key], depth + 1);
  };
  for (const input of inputs) visit(input);
  return values.join(' ').slice(0, 32_000);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): OperatorError {
  return new OperatorError('EXECUTION_ABORTED', 'Browser execution was cancelled.', { retryable: false });
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// Backward-compatible M0 name.
export class BrowserCdpInspectProvider extends BrowserCdpProvider {}
