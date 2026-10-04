import type { ActionRequest, ActionResult } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import type { CdpConnection, CdpTarget, JsonMap } from './browser-cdp-connection.ts';

const MAX_AX_NODES = 160;

export type BrowserObservationOptions = {
  controlOffset: number;
  textOffset: number;
  visualOffset: number;
  maxControls: number;
  maxText: number;
  maxVisuals: number;
  maxBytes: number;
  focusRef?: string;
  focusGroupRef?: string;
  focusRole?: string;
  focusText?: string;
  focusRegion?: { x: number; y: number; width: number; height: number };
};

export function normalizeObservationOptions(input: unknown): BrowserObservationOptions {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as JsonMap : {};
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = raw[key] === undefined ? fallback : Number(raw[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new OperatorError('BROWSER_OBSERVATION_BUDGET_INVALID', `${key} must be an integer between ${min} and ${max}.`);
    }
    return value;
  };
  const boundedString = (key: string, max: number) => {
    if (raw[key] === undefined) return undefined;
    if (typeof raw[key] !== 'string' || !String(raw[key]).trim()) throw new OperatorError('BROWSER_OBSERVATION_FOCUS_INVALID', `${key} must be a non-empty string.`);
    return String(raw[key]).trim().slice(0, max);
  };
  const regionRaw = raw.focusRegion && typeof raw.focusRegion === 'object' && !Array.isArray(raw.focusRegion) ? raw.focusRegion as JsonMap : undefined;
  const focusRegion = regionRaw ? {
    x: Number(regionRaw.x), y: Number(regionRaw.y), width: Number(regionRaw.width), height: Number(regionRaw.height)
  } : undefined;
  if (focusRegion && (![focusRegion.x, focusRegion.y, focusRegion.width, focusRegion.height].every(Number.isFinite) || focusRegion.width <= 0 || focusRegion.height <= 0 || focusRegion.width > 100_000 || focusRegion.height > 100_000)) {
    throw new OperatorError('BROWSER_OBSERVATION_FOCUS_INVALID', 'focusRegion must contain finite x/y and positive bounded width/height values.');
  }
  return {
    controlOffset: integer('controlOffset', 0, 0, 10_000),
    textOffset: integer('textOffset', 0, 0, 10_000),
    visualOffset: integer('visualOffset', 0, 0, 10_000),
    maxControls: integer('maxControls', 120, 1, 160),
    maxText: integer('maxText', 180, 1, 240),
    maxVisuals: integer('maxVisuals', 120, 1, 160),
    maxBytes: integer('maxBytes', 64 * 1024, 16 * 1024, 128 * 1024),
    ...(boundedString('focusRef', 128) ? { focusRef: boundedString('focusRef', 128) } : {}),
    ...(boundedString('focusGroupRef', 128) ? { focusGroupRef: boundedString('focusGroupRef', 128) } : {}),
    ...(boundedString('focusRole', 100) ? { focusRole: boundedString('focusRole', 100) } : {}),
    ...(boundedString('focusText', 500) ? { focusText: boundedString('focusText', 500) } : {}),
    ...(focusRegion ? { focusRegion } : {})
  };
}

export function assertLoopbackEndpoint(endpoint: URL): void {
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(endpoint.hostname)) {
    throw new OperatorError('UNSAFE_CDP_ENDPOINT', 'CDP provider only permits loopback endpoints.');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new OperatorError('UNSAFE_CDP_ENDPOINT', 'CDP discovery endpoint must use HTTP(S).');
  }
}

export function compactTab(tab: CdpTarget): JsonMap {
  return { id: tab.id, type: tab.type, title: tab.title, url: tab.url };
}

export function requireTarget(targets: CdpTarget[], id: string): CdpTarget {
  const target = targets.find((item) => item.id === id);
  if (!target) throw new OperatorError('BROWSER_TARGET_NOT_FOUND', `Browser target ${id} was not found.`, { retryable: true });
  return target;
}

export function requirePageTarget(targets: CdpTarget[]): CdpTarget {
  const target = targets.find((item) => item.type === 'page');
  if (!target) throw new OperatorError('BROWSER_TARGET_NOT_FOUND', 'No browser page target is available.', { retryable: true });
  return target;
}

export function validateNavigationUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new OperatorError('INVALID_URL', 'A valid absolute URL is required.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new OperatorError('URL_SCHEME_DENIED', 'Only HTTP(S) browser navigation is allowed.');
  if (url.username || url.password) throw new OperatorError('URL_CREDENTIALS_DENIED', 'Credentials must not be embedded in browser URLs.');
  return url.toString();
}

export function sameDestination(actualRaw: string, expectedRaw: string): boolean {
  try {
    const actual = new URL(actualRaw);
    const expected = new URL(expectedRaw);
    actual.hash = '';
    expected.hash = '';
    return actual.origin === expected.origin && actual.search === expected.search && (actual.pathname === expected.pathname || actual.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, ''));
  } catch { return false; }
}

export function unwrapRuntimeValue(result: JsonMap): unknown {
  const remote = result.result;
  return remote && typeof remote === 'object' ? (remote as JsonMap).value : undefined;
}

export async function pageIdentity(session: CdpConnection): Promise<{ url: string; title: string; readyState: string }> {
  const result = await session.send('Runtime.evaluate', {
    expression: '({url:location.href,title:document.title,readyState:document.readyState})',
    returnByValue: true
  });
  const value = unwrapRuntimeValue(result) as JsonMap | undefined;
  return {
    url: typeof value?.url === 'string' ? value.url : '',
    title: typeof value?.title === 'string' ? value.title : '',
    readyState: typeof value?.readyState === 'string' ? value.readyState : ''
  };
}

export async function waitForReadyState(session: CdpConnection, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const state = await pageIdentity(session);
    throwIfAborted(signal);
    if (state.readyState === 'interactive' || state.readyState === 'complete') return;
    await delay(75, signal);
  }
  throw new OperatorError('BROWSER_READY_TIMEOUT', 'Timed out waiting for the page to become ready.', { retryable: true });
}

export async function waitForDestinationReady(
  session: CdpConnection,
  expectedUrl: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ state: { url: string; title: string; readyState: string }; firstObservedUrl: string; polls: number; elapsedMs: number }> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let firstObservedUrl = '';
  let polls = 0;
  let lastState = { url: '', title: '', readyState: '' };
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    lastState = await pageIdentity(session);
    polls += 1;
    firstObservedUrl ||= lastState.url;
    throwIfAborted(signal);
    if (sameDestination(lastState.url, expectedUrl)
      && (lastState.readyState === 'interactive' || lastState.readyState === 'complete')) {
      return { state: lastState, firstObservedUrl, polls, elapsedMs: Date.now() - started };
    }
    await delay(75, signal);
  }
  throw new OperatorError('BROWSER_READY_TIMEOUT', 'Timed out waiting for the requested browser destination to become ready.', {
    retryable: true,
    details: { expectedUrl, firstObservedUrl, finalUrl: lastState.url, readyState: lastState.readyState, polls, elapsedMs: Date.now() - started }
  });
}

export interface BrowserSettleResult {
  settled: boolean;
  elapsedMs: number;
  reason: 'quiet' | 'timeout';
  lastMutationVersion: number;
  busy: number;
  dialogs: number;
  readyState: string;
}

export async function settleAfterInteraction(session: CdpConnection, signal?: AbortSignal, initialDelayMs = 50): Promise<BrowserSettleResult> {
  const started = Date.now();
  const initialDelay = Math.max(0, Math.min(500, initialDelayMs));
  const quietWindowMs = initialDelay >= 300 ? 180 : 80;
  const maxSettleMs = initialDelay >= 300 ? 1_800 : 1_000;
  await delay(initialDelay, signal);

  const readSettleState = async () => {
    const result = await session.send('Runtime.evaluate', {
      expression: `(() => {
        const registry = globalThis[Symbol.for('mecord.browser.observed-targets.v2')];
        const busy = document.querySelectorAll('[aria-busy="true"]').length;
        const dialogs = document.querySelectorAll('dialog[open],[role="dialog"][aria-modal="true"]').length;
        return {
          url: location.href,
          readyState: document.readyState,
          mutationVersion: Number.isSafeInteger(registry?.mutationVersion) ? registry.mutationVersion : 0,
          busy,
          dialogs
        };
      })()`,
      returnByValue: true
    });
    const value = unwrapRuntimeValue(result) as JsonMap | undefined;
    return {
      url: typeof value?.url === 'string' ? value.url : '',
      readyState: typeof value?.readyState === 'string' ? value.readyState : '',
      mutationVersion: Number.isSafeInteger(value?.mutationVersion) ? Number(value?.mutationVersion) : 0,
      busy: Number.isFinite(Number(value?.busy)) ? Number(value?.busy) : 0,
      dialogs: Number.isFinite(Number(value?.dialogs)) ? Number(value?.dialogs) : 0
    };
  };

  const deadline = Date.now() + maxSettleMs;
  let previous = await readSettleState();
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    await delay(40, signal);
    const current = await readSettleState();
    if (current.url !== previous.url
      || current.readyState !== previous.readyState
      || current.mutationVersion !== previous.mutationVersion
      || current.busy !== previous.busy
      || current.dialogs !== previous.dialogs) {
      quietSince = Date.now();
      previous = current;
      continue;
    }
    const ready = current.readyState === 'interactive' || current.readyState === 'complete';
    if (ready && current.busy === 0 && Date.now() - quietSince >= quietWindowMs) {
      return {
        settled: true, elapsedMs: Date.now() - started, reason: 'quiet',
        lastMutationVersion: current.mutationVersion, busy: current.busy, dialogs: current.dialogs, readyState: current.readyState
      };
    }
  }
  return {
    settled: false, elapsedMs: Date.now() - started, reason: 'timeout',
    lastMutationVersion: previous.mutationVersion, busy: previous.busy, dialogs: previous.dialogs, readyState: previous.readyState
  };
}

export async function inspectPage(session: CdpConnection, observation: BrowserObservationOptions): Promise<{
  url: string;
  title: string;
  readyState: string;
  accessibility: Array<{ role: string; name: string; value?: string }>;
  semantic: unknown;
}> {
  await session.send('Runtime.enable');
  await session.send('Accessibility.enable');
  const [identity, ax, dom] = await Promise.all([
    pageIdentity(session),
    session.send('Accessibility.getFullAXTree', { depth: 8 }),
    session.send('Runtime.evaluate', { expression: `(${semanticSnapshotFunction.toString()})(${JSON.stringify(observation)}, (${browserDomContractFunction.toString()})())`, returnByValue: true })
  ]);

  const nodes = Array.isArray(ax.nodes) ? ax.nodes as JsonMap[] : [];
  const accessibility = nodes.flatMap((node) => {
    const role = extractCdpValue(node.role);
    const name = extractCdpValue(node.name);
    if (!role || !name || !isUsefulRole(role)) return [];
    const value = extractCdpValue(node.value);
    return [{ role, name: name.slice(0, 240), ...(value ? { value: value.slice(0, 240) } : {}) }];
  }).slice(0, MAX_AX_NODES);

  return { ...identity, accessibility, semantic: unwrapRuntimeValue(dom) ?? null };
}

function extractCdpValue(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const value = (input as JsonMap).value;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

function isUsefulRole(role: string): boolean {
  return new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'tab', 'menuitem', 'heading', 'navigation', 'main', 'form', 'dialog', 'alert', 'treeitem', 'option']).has(role.toLowerCase());
}

export function normalizeTargetSpec(input: unknown): { ref?: string; css?: string; text?: string; role?: string; name?: string; renderedColor?: string } {
  const raw = input && typeof input === 'object' ? input as JsonMap : {};
  const clean = (key: string, max = 500) => typeof raw[key] === 'string' && String(raw[key]).trim() ? String(raw[key]).trim().slice(0, max) : undefined;
  return { ref: clean('ref', 128), css: clean('css'), text: clean('text'), role: clean('role'), name: clean('name'), renderedColor: clean('renderedColor', 64) };
}

export async function collectDiagnostics(session: CdpConnection): Promise<{
  stop(): void;
  snapshot(): { consoleErrors: string[]; networkFailures: Array<{ url?: string; errorText?: string; blockedReason?: string }> };
}> {
  const consoleErrors: string[] = [];
  const networkFailures: Array<{ url?: string; errorText?: string; blockedReason?: string }> = [];
  await Promise.allSettled([session.send('Runtime.enable'), session.send('Network.enable'), session.send('Log.enable')]);
  const off = [
    session.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails as JsonMap | undefined;
      const text = typeof details?.text === 'string' ? details.text : 'Uncaught page exception';
      if (consoleErrors.length < 50) consoleErrors.push(text.slice(0, 500));
    }),
    session.on('Log.entryAdded', (params) => {
      const entry = params.entry as JsonMap | undefined;
      if (entry?.level === 'error' && typeof entry.text === 'string' && consoleErrors.length < 50) consoleErrors.push(entry.text.slice(0, 500));
    }),
    session.on('Network.loadingFailed', (params) => {
      if (networkFailures.length >= 50) return;
      networkFailures.push({
        url: typeof params.url === 'string' ? params.url.slice(0, 1000) : undefined,
        errorText: typeof params.errorText === 'string' ? params.errorText.slice(0, 500) : undefined,
        blockedReason: typeof params.blockedReason === 'string' ? params.blockedReason : undefined
      });
    })
  ];
  return {
    stop: () => off.forEach((fn) => fn()),
    snapshot: () => ({ consoleErrors: [...consoleErrors], networkFailures: [...networkFailures] })
  };
}

export function failure(action: ActionRequest, provider: string, started: number, error: unknown): ActionResult {
  const op = error instanceof OperatorError
    ? error
    : new OperatorError('CDP_UNAVAILABLE', error instanceof Error ? error.message : String(error), { retryable: true });
  return {
    ok: false,
    capability: action.capability,
    provider,
    evidence: [evidence('browser_state', 'fail', op.message, { code: op.code })],
    error: {
      code: op.code,
      message: op.message,
      retryable: op.retryable,
      ...(op.details && ['none', 'known', 'uncertain'].includes(String(op.details.sideEffectState)) ? { sideEffectState: op.details.sideEffectState as 'none' | 'known' | 'uncertain' } : {}),
      ...(op.details && ['pre_dispatch', 'dispatched', 'effect_observed', 'reconciled'].includes(String(op.details.executionPhase))
        ? { executionPhase: op.details.executionPhase as 'pre_dispatch' | 'dispatched' | 'effect_observed' | 'reconciled' }
        : {}),
      ...(op.details ? { details: structuredClone(op.details) } : {})
    },
    durationMs: Math.round(performance.now() - started)
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): OperatorError {
  return new OperatorError('EXECUTION_ABORTED', 'Browser execution was cancelled.', { retryable: false });
}

export function browserDomContractFunction() {
  const stateOf = (element: Element) => {
    const documentOf = element.ownerDocument;
    const view = documentOf?.defaultView;
    const rect = (element as Element & { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect?.();
    let rendered = (element as Element & { isConnected?: boolean }).isConnected !== false;
    let disabled = Boolean((element as Element & { disabled?: boolean }).disabled);
    let pointerBlocked = false;

    for (let current: Element | null = element; current; current = current.parentElement) {
      if (current.hasAttribute('inert') || current.getAttribute('aria-hidden') === 'true') rendered = false;
      if (current.getAttribute('aria-disabled') === 'true') disabled = true;
      const style = view?.getComputedStyle?.(current);
      if (style) {
        if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none' || Number(style.opacity) === 0) rendered = false;
        if (style.pointerEvents === 'none') pointerBlocked = true;
      }
    }

    let inViewport = true;
    if (rect) {
      if (rect.width <= 0 || rect.height <= 0) rendered = false;
      const width = Number(view?.innerWidth ?? 0);
      const height = Number(view?.innerHeight ?? 0);
      if (width > 0 && height > 0) {
        inViewport = !(rect.right <= 0 || rect.bottom <= 0 || rect.left >= width || rect.top >= height);
      }
    }

    let occluded = false;
    if (rendered && inViewport && rect && !pointerBlocked) {
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const root = element.getRootNode?.() as (Document | ShadowRoot) | undefined;
      const rootHitTest = root && typeof (root as Document & { elementFromPoint?: (x: number, y: number) => Element | null }).elementFromPoint === 'function'
        ? (root as Document & { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint.bind(root)
        : root === documentOf && typeof documentOf?.elementFromPoint === 'function'
          ? documentOf.elementFromPoint.bind(documentOf)
          : undefined;
      const hit = rootHitTest?.(x, y) ?? null;
      if (hit && hit !== element && !element.contains(hit) && !hit.contains(element)) occluded = true;
    }

    const visible = rendered && inViewport;
    return {
      visible,
      rendered,
      inViewport,
      disabled,
      pointerBlocked,
      occluded,
      actionable: visible && !disabled && !pointerBlocked && !occluded,
      rect
    };
  };
  return { stateOf };
}

export function semanticSnapshotFunction(options: Partial<BrowserObservationOptions> = {}, contract = browserDomContractFunction()) {
  const trim = (value: unknown, max = 180) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const integer = (value: unknown, fallback: number, min: number, max: number) => Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max ? Number(value) : fallback;
  const budget = {
    controlOffset: integer(options.controlOffset, 0, 0, 10_000),
    textOffset: integer(options.textOffset, 0, 0, 10_000),
    visualOffset: integer(options.visualOffset, 0, 0, 10_000),
    maxControls: integer(options.maxControls, 120, 1, 160),
    maxText: integer(options.maxText, 180, 1, 240),
    maxVisuals: integer(options.maxVisuals, 120, 1, 160),
    maxBytes: integer(options.maxBytes, 64 * 1024, 16 * 1024, 128 * 1024)
  };
  const focus = {
    ref: typeof options.focusRef === 'string' ? options.focusRef : '',
    groupRef: typeof options.focusGroupRef === 'string' ? options.focusGroupRef : '',
    role: typeof options.focusRole === 'string' ? options.focusRole.toLowerCase() : '',
    text: typeof options.focusText === 'string' ? options.focusText.toLowerCase() : '',
    region: options.focusRegion
  };
  const registryKey = Symbol.for('mecord.browser.observed-targets.v2');
  const host = globalThis as typeof globalThis & { [key: symbol]: unknown };
  type ObservedFingerprint = { tag: string; id: string; role: string; semanticName: string; ariaLabel: string; name: string; text: string };
  type ObservedMutationObserver = { doc: Document; observer: MutationObserver };
  type ObservedRegistry = { nonce: string; generation: number; next: number; refs: Map<string, Element>; history: Map<string, ObservedFingerprint>; mutationVersion: number; observedDocs: WeakSet<Document>; observers: ObservedMutationObserver[] };
  let observedRegistry = host[registryKey] as ObservedRegistry | undefined;
  const priorFocusElement = focus.ref && observedRegistry?.refs instanceof Map ? observedRegistry.refs.get(focus.ref) : undefined;
  const priorGroupElement = focus.groupRef && observedRegistry?.refs instanceof Map ? observedRegistry.refs.get(focus.groupRef) : undefined;
  if (!observedRegistry || !(observedRegistry.refs instanceof Map)) {
    const bytes = new Uint32Array(2);
    try { globalThis.crypto?.getRandomValues?.(bytes); } catch { bytes[0] = Date.now() >>> 0; bytes[1] = Math.floor(Math.random() * 0xffffffff); }
    observedRegistry = { nonce: `${bytes[0]!.toString(36)}${bytes[1]!.toString(36)}`, generation: 0, next: 0, refs: new Map(), history: new Map(), mutationVersion: 0, observedDocs: new WeakSet(), observers: [] };
    host[registryKey] = observedRegistry;
  }
  if (!(observedRegistry.history instanceof Map)) observedRegistry.history = new Map();
  if (!Number.isSafeInteger(observedRegistry.mutationVersion)) observedRegistry.mutationVersion = 0;
  if (!(observedRegistry.observedDocs instanceof WeakSet)) observedRegistry.observedDocs = new WeakSet();
  if (!Array.isArray(observedRegistry.observers)) observedRegistry.observers = [];
  const rawObservers = observedRegistry.observers as unknown[];
  if (rawObservers.some((entry) => !entry || typeof entry !== 'object' || !('doc' in entry) || !('observer' in entry))) {
    for (const entry of rawObservers) {
      try { (entry as { disconnect?: () => void })?.disconnect?.(); } catch { /* already detached */ }
    }
    observedRegistry.observers = [];
    observedRegistry.observedDocs = new WeakSet();
  }
  const documentIsActive = (doc: Document) => {
    if (doc === document) return true;
    try {
      const frame = doc.defaultView?.frameElement as HTMLIFrameElement | null | undefined;
      if (!frame || frame.isConnected === false) return false;
      return frame.contentDocument === doc;
    } catch { return false; }
  };
  const liveObservers: ObservedMutationObserver[] = [];
  for (const entry of observedRegistry.observers) {
    if (documentIsActive(entry.doc)) liveObservers.push(entry);
    else {
      try { entry.observer.disconnect(); } catch { /* observer already inert */ }
    }
  }
  if (liveObservers.length !== observedRegistry.observers.length) {
    observedRegistry.observers = liveObservers;
    observedRegistry.observedDocs = new WeakSet(liveObservers.map((entry) => entry.doc));
  }
  const ensureMutationObserver = (doc: Document | null | undefined) => {
    if (!doc || observedRegistry!.observedDocs.has(doc)) return;
    const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    const root = doc.documentElement;
    if (!Observer || !root) return;
    try {
      const observer = new Observer(() => { observedRegistry!.mutationVersion += 1; });
      observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
      observedRegistry!.observedDocs.add(doc);
      observedRegistry!.observers.push({ doc, observer });
    } catch { /* same-origin document may disappear while observation is being built */ }
  };
  ensureMutationObserver(document);
  observedRegistry.generation += 1;
  observedRegistry.next = 0;
  observedRegistry.refs.clear();
  while (observedRegistry.history.size > 512) observedRegistry.history.delete(observedRegistry.history.keys().next().value as string);
  const observationGeneration = `${observedRegistry.nonce}-${observedRegistry.generation.toString(36)}`;
  const refByElement = new WeakMap<Element, string>();
  const observedRefOf = (element: Element) => {
    ensureMutationObserver(element.ownerDocument);
    const existing = refByElement.get(element);
    if (existing) return existing;
    const ref = `b-${observationGeneration}-${(++observedRegistry!.next).toString(36)}`;
    refByElement.set(element, ref);
    observedRegistry!.refs.set(ref, element);
    observedRegistry!.history.set(ref, {
      tag: element.tagName.toLowerCase(),
      id: trim(element.id, 160),
      role: trim(element.getAttribute('role'), 80).toLowerCase(),
      semanticName: '',
      ariaLabel: trim(element.getAttribute('aria-label'), 240),
      name: trim(element.getAttribute('name'), 240),
      text: trim(element.textContent, 240)
    });
    return ref;
  };
  const relationshipOf = (element: Element) => {
    const parent = element.parentElement;
    const ownText = trim((element as HTMLElement).innerText ?? element.textContent, 240);
    let contextLabel = '';
    const ancestorContextLabels: string[] = [];
    for (let current = parent, depth = 0; current && depth < 5; current = current.parentElement, depth += 1) {
      const candidate = trim((current as HTMLElement).innerText ?? current.textContent, 240);
      if (candidate && candidate !== ownText && candidate.length <= 240) {
        if (!contextLabel) contextLabel = candidate;
        if (!ancestorContextLabels.includes(candidate) && ancestorContextLabels.length < 4) ancestorContextLabels.push(candidate);
      }
      const classes = trim(current.getAttribute('class'), 160).split(/\s+/).filter(Boolean).slice(0, 4);
      const repeatedItem = classes.length > 0 && Boolean(current.parentElement && Array.from(current.parentElement.children).some((sibling) => {
        if (sibling === current || sibling.tagName !== current.tagName) return false;
        const siblingClasses = trim(sibling.getAttribute('class'), 160).split(/\s+/).filter(Boolean);
        return classes.every((name) => siblingClasses.includes(name));
      }));
      if (repeatedItem) break;
    }
    let group: Element | null = parent;
    for (let depth = 0; group && depth < 6; depth += 1, group = group.parentElement) {
      const groupRole = trim(group.getAttribute('role')).toLowerCase();
      if (['menu','menubar','tablist','tabpanel','tree','treeitem','list','listbox','grid','row','group','form','dialog','article','feed'].includes(groupRole) || ['FORM','LI','TR','TD','SECTION','ARTICLE','NAV'].includes(group.tagName)) break;
    }
    const children = Array.from(element.children ?? []).slice(0, 12).map((child) => observedRefOf(child));
    return {
      ...(parent ? { parentRef: observedRefOf(parent) } : {}),
      ...(group ? { groupRef: observedRefOf(group) } : {}),
      ...(contextLabel ? { contextLabel } : {}),
      ...(ancestorContextLabels.length ? { ancestorContextLabels } : {}),
      ...(children.length ? { children } : {}),
      ordinal: parent ? Array.from(parent.children).indexOf(element) + 1 : 1,
      depth: (() => { let d = 0; for (let current = element.parentElement; current; current = current.parentElement) d += 1; return d; })()
    };
  };
  const geometryOf = (element: Element, context: { frameDepth: number; shadowDepth: number }) => {
    const rect = element.getBoundingClientRect();
    let x = rect.x; let y = rect.y;
    let owner: Document | null = element.ownerDocument;
    let convertedDepth = 0;
    while (owner && owner !== document && convertedDepth < 4) {
      let frameElement: Element | null = null;
      try { frameElement = owner.defaultView?.frameElement as Element | null; } catch { frameElement = null; }
      if (!frameElement) break;
      const frameRect = frameElement.getBoundingClientRect();
      x += frameRect.x; y += frameRect.y;
      owner = frameElement.ownerDocument;
      convertedDepth += 1;
    }
    const coordinateSpace = owner === document ? 'viewport' : 'frame-viewport';
    return {
      coordinateSpace,
      frameDepth: context.frameDepth,
      x: Math.round(x), y: Math.round(y),
      width: Math.round(rect.width), height: Math.round(rect.height),
      center: { x: Math.round(x + rect.width / 2), y: Math.round(y + rect.height / 2) }
    };
  };
  const scrollStateOf = (element: Element) => {
    const doc = element.ownerDocument;
    const target = (element === doc?.body || element === doc?.documentElement) ? (doc.scrollingElement ?? element) : element;
    const node = target as HTMLElement;
    const top = Number(node.scrollTop); const left = Number(node.scrollLeft);
    const scrollHeight = Number(node.scrollHeight); const scrollWidth = Number(node.scrollWidth);
    const clientHeight = Number(node.clientHeight); const clientWidth = Number(node.clientWidth);
    if (![top, left, scrollHeight, scrollWidth, clientHeight, clientWidth].every(Number.isFinite)) return undefined;
    return {
      top, left, scrollHeight, scrollWidth, clientHeight, clientWidth,
      canScrollY: scrollHeight > clientHeight + 1,
      canScrollX: scrollWidth > clientWidth + 1
    };
  };
  const focusScoreOf = (element: Element, role: string, text: string, geometry: { x: number; y: number; width: number; height: number }) => {
    let score = 0;
    if (priorFocusElement === element) score += 1000;
    try {
      if (priorGroupElement && (priorGroupElement === element || priorGroupElement.contains(element) || element.contains(priorGroupElement))) score += 650;
    } catch { /* detached/cross-realm relationship changed */ }
    if (focus.role && role.toLowerCase() === focus.role) score += 300;
    if (focus.text && text.toLowerCase().includes(focus.text)) score += 350;
    const region = focus.region;
    if (region) {
      const right = geometry.x + geometry.width; const bottom = geometry.y + geometry.height;
      const regionRight = region.x + region.width; const regionBottom = region.y + region.height;
      if (geometry.x < regionRight && right > region.x && geometry.y < regionBottom && bottom > region.y) score += 250;
    }
    return score;
  };
  const visualFactsOf = (element: Element) => {
    const tag = element.tagName.toLowerCase();
    const finiteAttr = (name: string) => { const raw = element.getAttribute(name); if (raw === null || raw.trim() === '') return undefined; const value = Number(raw); return Number.isFinite(value) ? value : undefined; };
    const grid = {
      row: finiteAttr('aria-rowindex'),
      column: finiteAttr('aria-colindex'),
      rowSpan: finiteAttr('aria-rowspan'),
      columnSpan: finiteAttr('aria-colspan')
    };
    const screenMatrix = (() => {
      try {
        const matrix = (element as Element & { getScreenCTM?: () => { a: number; b: number; c: number; d: number; e: number; f: number } | null }).getScreenCTM?.();
        return matrix && [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every(Number.isFinite) ? matrix : undefined;
      } catch { return undefined; }
    })();
    const toViewport = (point: { x: number; y: number }) => screenMatrix ? {
      x: Math.round((screenMatrix.a * point.x + screenMatrix.c * point.y + screenMatrix.e) * 1000) / 1000,
      y: Math.round((screenMatrix.b * point.x + screenMatrix.d * point.y + screenMatrix.f) * 1000) / 1000
    } : undefined;
    if (tag === 'polygon' || tag === 'polyline') {
      const nums = trim(element.getAttribute('points'), 2048).split(/[\s,]+/).map(Number).filter(Number.isFinite).slice(0, 128);
      const points: Array<{ x: number; y: number }> = [];
      for (let index = 0; index + 1 < nums.length; index += 2) points.push({ x: nums[index]!, y: nums[index + 1]! });
      const viewportPoints = points.map(toViewport).filter((point): point is { x: number; y: number } => Boolean(point));
      return { ...(points.length ? { points, pointCount: points.length, pointsCoordinateSpace: 'svg-local', ...(viewportPoints.length === points.length ? { viewportPoints, viewportPointsCoordinateSpace: 'viewport' } : {}) } : {}), ...grid };
    }
    if (tag === 'line') {
      const line = { coordinateSpace: 'svg-local', x1: finiteAttr('x1'), y1: finiteAttr('y1'), x2: finiteAttr('x2'), y2: finiteAttr('y2') };
      const first = line.x1 === undefined || line.y1 === undefined ? undefined : toViewport({ x: line.x1, y: line.y1 });
      const second = line.x2 === undefined || line.y2 === undefined ? undefined : toViewport({ x: line.x2, y: line.y2 });
      const localVector = line.x1 === undefined || line.y1 === undefined || line.x2 === undefined || line.y2 === undefined ? undefined : (() => {
        const dx = line.x2 - line.x1; const dy = line.y2 - line.y1;
        return { dx, dy, length: Math.round(Math.hypot(dx, dy) * 1000) / 1000, angleDegrees: Math.round((Math.atan2(dy, dx) * 180 / Math.PI) * 1000) / 1000 };
      })();
      const viewportLine = first && second ? { coordinateSpace: 'viewport', x1: first.x, y1: first.y, x2: second.x, y2: second.y, vector: { dx: second.x - first.x, dy: second.y - first.y, length: Math.round(Math.hypot(second.x - first.x, second.y - first.y) * 1000) / 1000, angleDegrees: Math.round((Math.atan2(second.y - first.y, second.x - first.x) * 180 / Math.PI) * 1000) / 1000 } } : undefined;
      return { line: { ...line, ...(localVector ? { vector: localVector } : {}) }, ...(viewportLine ? { viewportLine } : {}), ...grid };
    }
    if (tag === 'circle') {
      const circle = { coordinateSpace: 'svg-local', cx: finiteAttr('cx'), cy: finiteAttr('cy'), r: finiteAttr('r') };
      const viewportCenter = circle.cx === undefined || circle.cy === undefined ? undefined : toViewport({ x: circle.cx, y: circle.cy });
      return { circle, ...(viewportCenter ? { viewportCenter: { coordinateSpace: 'viewport', ...viewportCenter } } : {}), ...grid };
    }
    if (tag === 'ellipse') return { ellipse: { coordinateSpace: 'svg-local', cx: finiteAttr('cx'), cy: finiteAttr('cy'), rx: finiteAttr('rx'), ry: finiteAttr('ry') }, ...grid };
    if (tag === 'rect') return { svgRect: { coordinateSpace: 'svg-local', x: finiteAttr('x'), y: finiteAttr('y'), width: finiteAttr('width'), height: finiteAttr('height'), rx: finiteAttr('rx'), ry: finiteAttr('ry') }, ...grid };
    return grid;
  };
  const legacySliderRoot = (element: Element) => {
    let current: Element | null = element;
    for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
      const className = current.getAttribute('class') ?? '';
      if (/slider[-_]?handle/i.test(className)) continue;
      if (/(?:^|\s)(?:[\w-]*slider[\w-]*)(?:\s|$)/i.test(className)) return current;
    }
    return null;
  };
  const isLegacySliderHandle = (element: Element) => {
    const tabIndex = (element as HTMLElement).tabIndex;
    const classes = element.getAttribute('class') ?? '';
    return tabIndex >= 0 && /slider/i.test(classes) && Boolean(legacySliderRoot(element.parentElement ?? element));
  };
  const displayedSliderValue = (element: Element) => {
    const root = legacySliderRoot(element);
    const parent = root?.parentElement;
    const numeric = /^-?(?:\d+\.?\d*|\.\d+)$/;
    for (const sibling of Array.from(parent?.children ?? [])) {
      if (sibling === root) continue;
      const candidate = trim(sibling.textContent, 80);
      if (numeric.test(candidate)) return candidate;
    }
    return '';
  };
  const deepQuery = (selector: string, max = 1000) => {
    const found: Array<{ element: Element; context: { frameDepth: number; shadowDepth: number } }> = [];
    const seenScopes = new Set<unknown>();
    let scanned = 0;
    const visit = (scope: Document | ShadowRoot | Element, frameDepth: number, shadowDepth: number) => {
      if (!scope || seenScopes.has(scope) || found.length >= max || scanned >= 5000) return;
      seenScopes.add(scope);
      let elements: Element[] = [];
      try { elements = Array.from(scope.querySelectorAll('*')).slice(0, 2500); } catch { return; }
      for (const element of elements) {
        if (found.length >= max || scanned++ >= 5000) break;
        try { if (element.matches(selector)) found.push({ element, context: { frameDepth, shadowDepth } }); } catch { /* invalid selector */ }
        const shadow = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
        if (shadow && shadowDepth < 8) visit(shadow, frameDepth, shadowDepth + 1);
        if (element.tagName === 'IFRAME' && frameDepth < 4) {
          try {
            const frameDocument = (element as HTMLIFrameElement).contentDocument;
            if (frameDocument?.documentElement) visit(frameDocument, frameDepth + 1, shadowDepth);
          } catch { /* cross-origin frame: remain isolated */ }
        }
      }
    };
    visit(document, 0, 0);
    return found;
  };
  const viewOf = (element: Element) => element.ownerDocument?.defaultView;
  const styleOf = (element: Element) => viewOf(element)?.getComputedStyle?.(element);
  const visible = (element: Element) => contract.stateOf(element).visible;
  const readableText = (element: Element, max = 180) => {
    const style = styleOf(element);
    const fontSize = Number.parseFloat(String(style?.fontSize ?? ''));
    if (Number.isFinite(fontSize) && fontSize <= 0) return '';
    if (style && Number(style.opacity) === 0) return '';
    return trim(element.textContent, max);
  };
  const cssEscape = (value: string) => {
    const css = (viewOf(document.documentElement) as Window & { CSS?: { escape?: (input: string) => string } } | undefined)?.CSS;
    return css?.escape ? css.escape(value) : value.replace(/[^A-Za-z0-9_-]/g, (char) => '\\' + char);
  };
  const selectorOf = (element: Element) => {
    if (element.id) return '#' + cssEscape(element.id);
    const parts: string[] = [];
    let current: Element | null = element;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const tag = current.tagName.toLowerCase();
      const classList = Array.from(current.classList ?? []).filter((name) => /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(name)).slice(0, 2);
      let part = tag + classList.map((name) => '.' + cssEscape(name)).join('');
      const parent: Element | null = current.parentElement;
      if (parent) {
        const siblings: Element[] = Array.from(parent.children).filter((sibling: Element) => sibling.tagName === current!.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      if (!parent || ['BODY', 'HTML'].includes(parent.tagName)) break;
      if (parent.id) {
        parts.unshift('#' + cssEscape(parent.id));
        break;
      }
      current = parent;
    }
    return parts.join(' > ');
  };
  const accessibleName = (element: Element) => {
    const aria = element.getAttribute('aria-label');
    if (aria) return trim(aria);
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const root = element.getRootNode() as Document | ShadowRoot;
      const labels = labelledBy.split(/\s+/).map((id) => (root as Document).getElementById?.(id)?.textContent ?? '').filter(Boolean);
      if (labels.length) return trim(labels.join(' '));
    }
    const control = element as Element & { labels?: ArrayLike<Element> | null; placeholder?: string; name?: string; id?: string };
    if (control.labels?.length) return trim(Array.from(control.labels).map((label) => label.textContent).join(' '));
    if (roleOf(element) === 'slider') {
      const labelledAncestor = element.parentElement?.closest('[aria-label],[title],[id]');
      const ancestorName = labelledAncestor?.getAttribute('aria-label') || labelledAncestor?.getAttribute('title') || labelledAncestor?.getAttribute('id');
      if (ancestorName) return trim(ancestorName);
    }
    const explicitRole = trim(element.getAttribute('role')).toLowerCase();
    const nativeText = ['BUTTON', 'SUMMARY', 'A', 'OPTION'].includes(element.tagName) ? readableText(element) : '';
    const roleText = explicitRole && !['textbox', 'searchbox', 'combobox', 'slider'].includes(explicitRole) ? readableText(element) : '';
    return trim(
      element.getAttribute('placeholder')
      || nativeText
      || roleText
      || element.getAttribute('title')
      || element.getAttribute('name')
      || element.id
      || readableText(element)
    );
  };
  const roleOf = (element: Element) => {
    const explicit = trim(element.getAttribute('role')).toLowerCase();
    if (explicit) return explicit;
    if (element.hasAttribute('aria-valuenow')) return 'slider';
    if (element.tagName === 'INPUT' && trim(element.getAttribute('type')).toLowerCase() === 'range') return 'slider';
    if (isLegacySliderHandle(element)) return 'slider';
    const tag = element.tagName;
    if (tag === 'A' && element.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if ((element as HTMLElement).isContentEditable === true || trim(element.getAttribute('contenteditable')).toLowerCase() === 'true') return 'textbox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'OPTION') return 'option';
    if (tag === 'INPUT') {
      const type = trim(element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    return '';
  };
  const editableElement = (element: Element) => {
    if ((element as HTMLElement).isContentEditable === true || trim(element.getAttribute('contenteditable')).toLowerCase() === 'true') return true;
    if (element.tagName === 'TEXTAREA') return true;
    if (element.tagName !== 'INPUT') return false;
    const type = trim(element.getAttribute('type') || 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'range', 'file', 'color', 'hidden'].includes(type);
  };
  const hoverPointerSelectors = (() => {
    const selectors: string[] = [];
    const visitRules = (rules: CSSRuleList | ArrayLike<CSSRule> | undefined, depth = 0) => {
      if (!rules || depth > 4 || selectors.length >= 256) return;
      for (const rule of Array.from(rules).slice(0, 512)) {
        if (selectors.length >= 256) break;
        const styleRule = rule as CSSStyleRule;
        const nested = rule as CSSGroupingRule;
        try {
          if (typeof styleRule.selectorText === 'string' && styleRule.style?.cursor === 'pointer') {
            for (const raw of styleRule.selectorText.split(',')) {
              const selector = raw.replace(/:(?:hover|focus|active)(?:\([^)]*\))?/gi, '').trim();
              if (selector && selector.length <= 512 && !selectors.includes(selector)) selectors.push(selector);
            }
          }
          if (nested.cssRules) visitRules(nested.cssRules, depth + 1);
        } catch { /* cross-origin or unsupported stylesheet rule */ }
      }
    };
    for (const sheet of Array.from(document.styleSheets ?? []).slice(0, 128)) {
      try { visitRules(sheet.cssRules); } catch { /* cross-origin stylesheet stays opaque */ }
    }
    return selectors;
  })();
  const pointerStyled = (element: Element) => {
    const style = viewOf(element)?.getComputedStyle?.(element);
    if (style?.cursor === 'pointer') return true;
    return hoverPointerSelectors.some((selector) => {
      try { return element.matches(selector); } catch { return false; }
    });
  };
  const semanticControls = deepQuery('button,a[href],input,textarea,select,option,summary,[role],[aria-valuenow],[tabindex],[contenteditable="true"]', 320);
  const seenControls = new Set(semanticControls.map(({ element }) => element));
  const pointerControls = deepQuery('*', 600)
    .filter(({ element }) => {
      if (seenControls.has(element) || !visible(element)) return false;
      return contract.stateOf(element).actionable && pointerStyled(element);
    });
  const controlCandidates = [...semanticControls, ...pointerControls]
    .filter(({ element }) => visible(element) || (editableElement(element) && element.ownerDocument?.activeElement === element))
    .map(({ element, context }) => {
      const state = contract.stateOf(element);
      const semanticRole = roleOf(element);
      const role = semanticRole || (pointerStyled(element) ? 'pointer' : '');
      const semanticName = accessibleName(element);
      const ref = observedRefOf(element);
      const priorFingerprint = observedRegistry!.history.get(ref)!;
      observedRegistry!.history.set(ref, { ...priorFingerprint, role, semanticName });
      const rect = element.getBoundingClientRect();
      const inputType = element.tagName === 'INPUT' ? trim(element.getAttribute('type') || 'text').toLowerCase() : '';
      const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLOptionElement;
      const readableValue = element.tagName === 'INPUT' && inputType === 'password'
        ? ''
        : ['INPUT', 'TEXTAREA', 'SELECT', 'OPTION'].includes(element.tagName) ? String((control as HTMLInputElement).value ?? '').slice(0, 500) : '';
      const ariaAutocomplete = trim(element.getAttribute('aria-autocomplete'), 80);
      const autocomplete = Boolean(
        ariaAutocomplete
        || element.hasAttribute('list')
        || trim(element.getAttribute('role')).toLowerCase() === 'combobox'
        || /(?:^|\s)ui-autocomplete-input(?:\s|$)/i.test(element.getAttribute('class') ?? '')
      );
      const popupId = trim(element.getAttribute('aria-controls') || element.getAttribute('aria-owns') || element.getAttribute('list'), 240);
      const scroll = scrollStateOf(element);
      return {
        ref,
        tag: element.tagName.toLowerCase(),
        selector: selectorOf(element),
        role,
        name: semanticName,
        type: inputType,
        semanticType: inputType || semanticRole || element.tagName.toLowerCase(),
        ...(editableElement(element) ? { editable: true } : {}),
        ...(!state.visible ? { visuallyHidden: true } : {}),
        ...(!state.visible && editableElement(element) && element.ownerDocument?.activeElement === element ? { keyboardSink: true } : {}),
        ...(inputType === 'date' ? { nativeValueFormat: 'YYYY-MM-DD' } : {}),
        ...(readableValue ? { value: readableValue } : {}),
        ...(autocomplete ? { autocomplete: true, ...(ariaAutocomplete ? { autocompleteMode: ariaAutocomplete } : {}), ...(popupId ? { popupId } : {}) } : {}),
        ...(['checkbox', 'radio'].includes(inputType) ? { checked: Boolean((element as HTMLInputElement).checked) } : element.hasAttribute('aria-checked') ? { checked: element.getAttribute('aria-checked') === 'true' } : {}),
        ...(element.tagName === 'OPTION' ? { selected: Boolean((element as HTMLOptionElement).selected) } : element.hasAttribute('aria-selected') ? { selected: element.getAttribute('aria-selected') === 'true' } : {}),
        ...(element.tagName === 'SELECT' ? { multiple: Boolean((element as HTMLSelectElement).multiple) } : {}),
        ...(element.hasAttribute('aria-expanded') ? { expanded: element.getAttribute('aria-expanded') === 'true' } : {}),
        ...(element.hasAttribute('aria-pressed') ? { pressed: element.getAttribute('aria-pressed') === 'true' } : {}),
        ...(element.hasAttribute('aria-current') ? { current: trim(element.getAttribute('aria-current'), 80) } : {}),
        ...((element as HTMLInputElement).readOnly === true || element.getAttribute('aria-readonly') === 'true' ? { readonly: true } : {}),
        ...(element.getAttribute('placeholder') ? { placeholder: trim(element.getAttribute('placeholder'), 240) } : {}),
        active: element.ownerDocument?.activeElement === element,
        ...(scroll ? { scrollable: scroll.canScrollY || scroll.canScrollX, scroll } : {}),
        disabled: state.disabled,
        actionable: state.actionable,
        ...(state.pointerBlocked ? { pointerBlocked: true } : {}),
        ...(state.occluded ? { occluded: true } : {}),
        ...relationshipOf(element),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        geometry: geometryOf(element, context),
        ...(semanticRole === 'slider' ? {
          min: trim(element.tagName === 'INPUT' ? (element as HTMLInputElement).min || element.getAttribute('aria-valuemin') || '' : element.getAttribute('aria-valuemin') || ''),
          max: trim(element.tagName === 'INPUT' ? (element as HTMLInputElement).max || element.getAttribute('aria-valuemax') || '' : element.getAttribute('aria-valuemax') || ''),
          step: trim(element.tagName === 'INPUT' ? (element as HTMLInputElement).step || element.getAttribute('aria-valuestep') || '1' : element.getAttribute('aria-valuestep') || element.getAttribute('step') || '1'),
          value: trim(element.tagName === 'INPUT' ? (element as HTMLInputElement).value : element.getAttribute('aria-valuenow') || displayedSliderValue(element))
        } : {}),
        href: element.tagName === 'A' ? trim((element as HTMLAnchorElement).href, 500) : '',
        _focusScore: focusScoreOf(element, role, semanticName, geometryOf(element, context)),
        context
      };
    })
    .filter((item) => (item.role && (item.name || item.role === 'slider' || item.role === 'pointer' || item.keyboardSink === true)) || item.href)
    .sort((left, right) => {
      const score = (item: typeof left) => item._focusScore
        + (item.actionable ? 50 : 0)
        + (item.role === 'pointer' ? 20 : 40)
        + (item.name ? 10 : 0)
        + (item.href ? 5 : 0)
        + (item.role === 'slider' ? 5 : 0);
      return score(right) - score(left)
        || left.rect.y - right.rect.y
        || left.rect.x - right.rect.x
        || left.selector.localeCompare(right.selector);
    });
  const controls = controlCandidates.slice(budget.controlOffset, budget.controlOffset + budget.maxControls).map(({ _focusScore, ...item }) => item);
  const visibleTextCandidates = deepQuery('*', 600)
    .filter(({ element }) => visible(element)
      && Array.from(element.children ?? []).length === 0
      && Boolean(readableText(element)))
    .map(({ element, context }) => {
      const rect = element.getBoundingClientRect();
      return {
        ref: observedRefOf(element),
        tag: element.tagName.toLowerCase(),
        selector: selectorOf(element),
        text: readableText(element),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        geometry: geometryOf(element, context),
        _focusScore: focusScoreOf(element, roleOf(element), readableText(element), geometryOf(element, context)),
        context
      };
    })
    .sort((left, right) => {
      const semanticScore = (item: typeof left) => item._focusScore
        + (/^-?(?:\d+\.?\d*|\.\d+)$/.test(item.text) ? 20 : 0)
        + (item.text.length <= 80 ? 5 : 0);
      return semanticScore(right) - semanticScore(left)
        || left.rect.y - right.rect.y
        || left.rect.x - right.rect.x
        || left.selector.localeCompare(right.selector);
    });
  const visibleText = visibleTextCandidates.slice(budget.textOffset, budget.textOffset + budget.maxText).map(({ _focusScore, ...item }) => item);
  const headings = deepQuery('h1,h2,h3,[role="heading"]', 80).filter(({ element }) => visible(element)).map(({ element }) => readableText(element)).filter(Boolean).slice(0, 60);
  const forms = deepQuery('form', 30).map(({ element: form, context }) => {
    const anyForm = form as HTMLFormElement;
    return {
      name: trim(form.getAttribute('aria-label') || form.getAttribute('name') || form.id),
      action: trim(anyForm.action, 500),
      fields: Array.from(anyForm.elements ?? []).slice(0, 60).map((field) => field instanceof Element ? accessibleName(field) : '').filter(Boolean),
      context
    };
  });
  const visualCandidates = deepQuery('*', 600).flatMap(({ element, context }) => {
    const state = contract.stateOf(element);
    if (!state.visible) return [];
    const style = viewOf(element)?.getComputedStyle?.(element);
    const colors = {
      background: trim(style?.backgroundColor, 64).toLowerCase(),
      fill: trim(style?.fill, 64).toLowerCase(),
      stroke: trim(style?.stroke, 64).toLowerCase()
    };
    const scroll = scrollStateOf(element);
    const scrollable = Boolean(scroll?.canScrollY || scroll?.canScrollX);
    const meaningful = Object.values(colors).some((color) => color && color !== 'none' && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)');
    if (!meaningful && !scrollable) return [];
    const rect = element.getBoundingClientRect();
    if (rect.width * rect.height < 16) return [];
    const role = roleOf(element);
    const pointer = style?.cursor === 'pointer' && !state.pointerBlocked;
    const interactive = Boolean(pointer || role || ['BUTTON', 'A', 'INPUT', 'SUMMARY'].includes(element.tagName));
    const effectiveRole = role || (pointer ? 'pointer' : '');
    const geometry = geometryOf(element, context);
    return [{ ref: observedRefOf(element), tag: element.tagName.toLowerCase(), primitive: element.tagName.toLowerCase(), selector: selectorOf(element), name: accessibleName(element), role: effectiveRole, ...relationshipOf(element), ...visualFactsOf(element), colors, opacity: trim(style?.opacity, 32), rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, geometry, ...(scroll ? { scrollable: scroll.canScrollY || scroll.canScrollX, scroll } : {}), actionable: state.actionable && interactive, ...(state.occluded ? { occluded: true } : {}), _focusScore: focusScoreOf(element, effectiveRole, accessibleName(element) || readableText(element), geometry), context }];
  }).sort((left, right) => {
    const score = (item: typeof left) => item._focusScore
      + (item.actionable ? 50 : 0)
      + (['circle', 'rect', 'polygon', 'path', 'ellipse', 'svg'].includes(item.tag) ? 40 : 0)
      + (item.scrollable ? 60 : 0)
      + (item.role ? 10 : 0)
      + (item.name ? 5 : 0);
    const leftArea = left.rect.width * left.rect.height;
    const rightArea = right.rect.width * right.rect.height;
    return score(right) - score(left)
      || leftArea - rightArea
      || left.rect.y - right.rect.y
      || left.rect.x - right.rect.x
      || left.selector.localeCompare(right.selector);
  });
  const visualObjects = visualCandidates.slice(budget.visualOffset, budget.visualOffset + budget.maxVisuals).map(({ _focusScore, ...item }) => item);
  const pageScroller = document.scrollingElement ?? document.documentElement;
  const pageScrollState = pageScroller ? scrollStateOf(pageScroller) : undefined;
  const pageScroll = pageScroller && pageScrollState && (pageScrollState.canScrollY || pageScrollState.canScrollX)
    ? { ref: observedRefOf(pageScroller), selector: selectorOf(pageScroller), scroll: pageScrollState, geometry: geometryOf(pageScroller, { frameDepth: 0, shadowDepth: 0 }) }
    : undefined;
  const pageMeta = (total: number, offset: number, limit: number, returned: number) => {
    const nextOffset = offset + returned;
    const truncated = nextOffset < total;
    return { offset, limit, returned, total, truncated, ...(truncated ? { nextOffset } : {}) };
  };
  return {
    schemaVersion: 2,
    observationGeneration,
    documentMutationVersion: observedRegistry.mutationVersion,
    coordinateSpace: 'viewport',
    focus: {
      ...(focus.ref ? { ref: focus.ref, refResolved: Boolean(priorFocusElement) } : {}),
      ...(focus.groupRef ? { groupRef: focus.groupRef, groupRefResolved: Boolean(priorGroupElement) } : {}),
      ...(focus.role ? { role: focus.role } : {}),
      ...(focus.text ? { text: focus.text } : {}),
      ...(focus.region ? { region: focus.region } : {})
    },
    budgets: budget,
    pagination: {
      controls: pageMeta(controlCandidates.length, budget.controlOffset, budget.maxControls, controls.length),
      visibleText: pageMeta(visibleTextCandidates.length, budget.textOffset, budget.maxText, visibleText.length),
      visualObjects: pageMeta(visualCandidates.length, budget.visualOffset, budget.maxVisuals, visualObjects.length)
    },
    headings, controls, forms, visualObjects, visuals: visualObjects, visibleText,
    ...(pageScroll ? { pageScroll } : {}),
    textExcerpt: trim(visibleText.map((item) => item.text).join(' '), 1600)
  };
}

export function interactionFunction(input: { operation: string; target: { ref?: string; css?: string; text?: string; role?: string; name?: string; renderedColor?: string }; value: unknown; deltaX?: number; deltaY?: number; key?: string; keys?: string[]; start?: number; end?: number }, contract = browserDomContractFunction()) {
  const trim = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const legacySliderRoot = (element: Element) => {
    let current: Element | null = element;
    for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
      const className = current.getAttribute('class') ?? '';
      if (/slider[-_]?handle/i.test(className)) continue;
      if (/(?:^|\s)(?:[\w-]*slider[\w-]*)(?:\s|$)/i.test(className)) return current;
    }
    return null;
  };
  const isLegacySliderHandle = (element: Element) => (element as HTMLElement).tabIndex >= 0
    && /slider/i.test(element.getAttribute('class') ?? '')
    && Boolean(legacySliderRoot(element.parentElement ?? element));
  const displayedSliderValue = (element: Element) => {
    const root = legacySliderRoot(element);
    const numeric = /^-?(?:\d+\.?\d*|\.\d+)$/;
    for (const sibling of Array.from(root?.parentElement?.children ?? [])) {
      if (sibling === root) continue;
      const candidate = trim(sibling.textContent);
      if (numeric.test(candidate)) return candidate;
    }
    return '';
  };
  const deepQuery = (selector: string, max = 1000) => {
    const found: Array<{ element: Element; context: { frameDepth: number; shadowDepth: number } }> = [];
    const seenScopes = new Set<unknown>();
    let scanned = 0;
    const visit = (scope: Document | ShadowRoot | Element, frameDepth: number, shadowDepth: number) => {
      if (!scope || seenScopes.has(scope) || found.length >= max || scanned >= 5000) return;
      seenScopes.add(scope);
      let elements: Element[] = [];
      try { elements = Array.from(scope.querySelectorAll('*')).slice(0, 2500); } catch { return; }
      for (const element of elements) {
        if (found.length >= max || scanned++ >= 5000) break;
        try { if (element.matches(selector)) found.push({ element, context: { frameDepth, shadowDepth } }); } catch { /* invalid selector */ }
        const shadow = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
        if (shadow && shadowDepth < 8) visit(shadow, frameDepth, shadowDepth + 1);
        if (element.tagName === 'IFRAME' && frameDepth < 4) {
          try {
            const frameDocument = (element as HTMLIFrameElement).contentDocument;
            if (frameDocument?.documentElement) visit(frameDocument, frameDepth + 1, shadowDepth);
          } catch { /* cross-origin frame: remain isolated */ }
        }
      }
    };
    visit(document, 0, 0);
    return found;
  };
  const nameOf = (element: Element) => {
    const aria = element.getAttribute('aria-label');
    if (aria) return trim(aria);
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const root = element.getRootNode() as Document | ShadowRoot;
      const labels = labelledBy.split(/\s+/).map((id) => (root as Document).getElementById?.(id)?.textContent ?? '').filter(Boolean);
      if (labels.length) return trim(labels.join(' '));
    }
    const control = element as Element & { labels?: ArrayLike<Element> | null };
    if (control.labels?.length) return trim(Array.from(control.labels).map((label) => label.textContent).join(' '));
    if (roleOf(element) === 'slider') {
      const labelledAncestor = element.parentElement?.closest('[aria-label],[title],[id]');
      const ancestorName = labelledAncestor?.getAttribute('aria-label') || labelledAncestor?.getAttribute('title') || labelledAncestor?.getAttribute('id');
      if (ancestorName) return trim(ancestorName);
    }
    const explicitRole = trim(element.getAttribute('role')).toLowerCase();
    const nativeText = ['BUTTON', 'SUMMARY', 'A', 'OPTION'].includes(element.tagName) ? trim(element.textContent) : '';
    const roleText = explicitRole && !['textbox', 'searchbox', 'combobox', 'slider'].includes(explicitRole) ? trim(element.textContent) : '';
    return trim(
      element.getAttribute('placeholder')
      || nativeText
      || roleText
      || element.getAttribute('title')
      || element.getAttribute('name')
      || element.id
      || element.textContent
    );
  };
  const roleOf = (element: Element) => {
    const explicit = trim(element.getAttribute('role')).toLowerCase();
    if (explicit) return explicit;
    if (element.hasAttribute('aria-valuenow')) return 'slider';
    if (element.tagName === 'INPUT' && trim(element.getAttribute('type')).toLowerCase() === 'range') return 'slider';
    if (isLegacySliderHandle(element)) return 'slider';
    const tag = element.tagName;
    if (tag === 'A' && element.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if ((element as HTMLElement).isContentEditable === true || trim(element.getAttribute('contenteditable')).toLowerCase() === 'true') return 'textbox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'OPTION') return 'option';
    if (tag === 'INPUT') {
      const type = trim(element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    return '';
  };
  const editableElement = (element: Element) => {
    if ((element as HTMLElement).isContentEditable === true || trim(element.getAttribute('contenteditable')).toLowerCase() === 'true') return true;
    if (element.tagName === 'TEXTAREA') return true;
    if (element.tagName !== 'INPUT') return false;
    const type = trim(element.getAttribute('type') || 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'range', 'file', 'color', 'hidden'].includes(type);
  };
  const visible = (element: Element) => { const state = contract.stateOf(element); return state.visible && !state.pointerBlocked && !state.occluded; };
  const eligibleForOperation = (element: Element) => visible(element)
    || (input.operation === 'focus' && editableElement(element) && element.ownerDocument?.activeElement === element);
  const normalizeColor = (raw: string) => {
    const probe = document.createElement?.('span');
    if (!probe) return trim(raw).toLowerCase();
    probe.style.color = '';
    probe.style.color = trim(raw);
    if (!probe.style.color) return trim(raw).toLowerCase();
    (document.body || document.documentElement)?.appendChild?.(probe);
    const normalized = probe.ownerDocument?.defaultView?.getComputedStyle?.(probe).color || probe.style.color;
    probe.remove?.();
    return trim(normalized).toLowerCase();
  };
  const renderedColors = (element: Element) => {
    const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
    return [style?.backgroundColor, style?.fill, style?.stroke].map((value) => trim(value).toLowerCase()).filter((value) => value && value !== 'none' && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)');
  };
  const registryKey = Symbol.for('mecord.browser.observed-targets.v2');
  type HistoricalFingerprint = { tag?: string; id?: string; role?: string; semanticName?: string; ariaLabel?: string; name?: string; text?: string };
  const registry = (globalThis as typeof globalThis & { [key: symbol]: { refs?: Map<string, Element>; history?: Map<string, HistoricalFingerprint> } | undefined })[registryKey];
  const observed = input.target.ref ? registry?.refs?.get(input.target.ref) : undefined;
  const historical = input.target.ref && !observed ? registry?.history?.get(input.target.ref) : undefined;
  const matchesHistorical = (element: Element, fingerprint: HistoricalFingerprint) => {
    if (fingerprint.tag && element.tagName.toLowerCase() !== fingerprint.tag) return false;
    if (fingerprint.id && element.id !== fingerprint.id) return false;
    if (fingerprint.ariaLabel && trim(element.getAttribute('aria-label')) !== fingerprint.ariaLabel) return false;
    if (fingerprint.name && trim(element.getAttribute('name')) !== fingerprint.name) return false;
    if (fingerprint.role && roleOf(element) !== fingerprint.role) return false;
    if (fingerprint.semanticName && nameOf(element) !== fingerprint.semanticName) return false;
    const strongSignals = [fingerprint.id, fingerprint.ariaLabel, fingerprint.name, fingerprint.semanticName].filter(Boolean).length;
    if (strongSignals > 0) return true;
    return Boolean(fingerprint.role && fingerprint.text && trim(element.textContent) === fingerprint.text);
  };
  const selector = input.target.css || (input.target.renderedColor ? '*' : 'button,a[href],input,textarea,select,option,summary,[role],[aria-valuenow],[tabindex],[contenteditable="true"]');
  const candidates = input.target.ref
    ? (observed && observed.isConnected !== false
      ? [{ element: observed, context: { frameDepth: observed.ownerDocument === document ? 0 : 1, shadowDepth: 0 } }]
      : historical ? deepQuery('*', 1000).filter(({ element }) => matchesHistorical(element, historical)) : [])
    : deepQuery(selector, 1000);
  const desiredColor = input.target.renderedColor ? normalizeColor(input.target.renderedColor) : '';
  let matching = candidates.filter(({ element }) => {
    if (!eligibleForOperation(element)) return false;
    if (input.target.text && !trim(element.textContent).toLowerCase().includes(input.target.text.toLowerCase())) return false;
    if (input.target.role && roleOf(element) !== input.target.role.toLowerCase()) return false;
    if (input.target.name && nameOf(element).toLowerCase() !== input.target.name.toLowerCase()) return false;
    if (desiredColor && !renderedColors(element).includes(desiredColor)) return false;
    return true;
  });
  if (!matching.length && !input.target.ref && !input.target.css && !input.target.role && !input.target.renderedColor && (input.target.text || input.target.name)) {
    const desired = (input.target.name || input.target.text || '').toLowerCase();
    matching = deepQuery('*', 1000).filter(({ element }) => {
      if (!visible(element)) return false;
      const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
      if (style?.cursor !== 'pointer') return false;
      const name = nameOf(element).toLowerCase();
      return input.target.name ? name === desired : (name === desired || trim(element.textContent).toLowerCase().includes(desired));
    });
  }
  if (matching.length > 1) {
    const exact = matching.filter(({ element }) => nameOf(element).toLowerCase() === (input.target.name || input.target.text || '').toLowerCase());
    if (exact.length === 1) matching = exact;
  }
  if (input.target.ref && !observed && matching.length === 1 && registry?.refs instanceof Map) {
    registry.refs.set(input.target.ref, matching[0]!.element);
  }
  if (matching.length > 1) return { ok: false, error: 'Semantic browser target matched multiple elements.', matches: matching.length };
  const match = matching[0];
  if (!match) return { ok: false, error: input.target.ref ? 'Observed browser target is stale; re-observe before retrying.' : 'No matching semantic element was found.', staleRef: Boolean(input.target.ref) };
  const { element, context } = match;
  const control = element as Element & {
    value?: string;
    disabled?: boolean;
    isContentEditable?: boolean;
    focus?: () => void;
    click?: () => void;
    dispatchEvent?: (event: Event) => boolean;
  };
  if (contract.stateOf(element).disabled) return { ok: false, error: 'Matched element is disabled.' };
  const initialRect = element.getBoundingClientRect();
  const ariaAutocomplete = trim(element.getAttribute('aria-autocomplete'));
  const autocomplete = Boolean(
    ariaAutocomplete
    || element.hasAttribute('list')
    || trim(element.getAttribute('role')).toLowerCase() === 'combobox'
    || /(?:^|\s)ui-autocomplete-input(?:\s|$)/i.test(element.getAttribute('class') ?? '')
  );
  const before = { name: nameOf(element), role: roleOf(element), value: typeof control.value === 'string' ? control.value : '', ...(autocomplete ? { autocomplete: true } : {}), geometry: { x: initialRect.x, y: initialRect.y, width: initialRect.width, height: initialRect.height } };
  const view = element.ownerDocument?.defaultView ?? window;

  const pointerPoint = (targetElement: Element) => {
    (targetElement as HTMLElement).scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
    const rect = targetElement.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
  };
  const dispatchPointer = (targetElement: Element, type: string, x: number, y: number, buttons: number) => {
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true, view };
    if (view.PointerEvent) targetElement.dispatchEvent(new view.PointerEvent(type.replace(/^mouse/, 'pointer'), init));
    targetElement.dispatchEvent(new view.MouseEvent(type, init));
  };

  if (input.operation === 'focus') {
    control.focus?.();
    const active = element.ownerDocument?.activeElement;
    if (active !== element && !element.contains(active)) return { ok: false, error: 'Matched element did not receive focus.' };
    return { ok: true, matched: { tag: element.tagName.toLowerCase(), ...before, context }, after: { ...before, focused: true } };
  }

  if (input.operation === 'select_text_range') {
    const start = Number(input.start);
    const end = Number(input.end);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > 100000) {
      return { ok: false, error: 'Text selection requires bounded integer start/end offsets.' };
    }
    control.focus?.();
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      const value = String(control.value ?? '');
      if (end > value.length) return { ok: false, error: 'Text selection range exceeds the visible control value.', length: value.length };
      (element as HTMLInputElement | HTMLTextAreaElement).setSelectionRange?.(start, end);
      const selectedStart = Number((element as HTMLInputElement | HTMLTextAreaElement).selectionStart);
      const selectedEnd = Number((element as HTMLInputElement | HTMLTextAreaElement).selectionEnd);
      if (selectedStart !== start || selectedEnd !== end) return { ok: false, error: 'Text selection postcondition failed.', expected: { start, end }, actual: { start: selectedStart, end: selectedEnd } };
      return { ok: true, matched: { tag: element.tagName.toLowerCase(), ...before, context }, after: { ...before, selection: { start, end } } };
    }
    const textNodes: Text[] = [];
    const visit = (node: Node) => {
      if (textNodes.length >= 2000) return;
      if (node.nodeType === 3) { textNodes.push(node as Text); return; }
      for (const child of Array.from(node.childNodes ?? [])) visit(child);
    };
    visit(element);
    const totalLength = textNodes.reduce((sum, node) => sum + (node.data?.length ?? 0), 0);
    if (end > totalLength) return { ok: false, error: 'Text selection range exceeds observed text.', length: totalLength };
    const locate = (offset: number) => {
      let remaining = offset;
      for (const node of textNodes) {
        const length = node.data?.length ?? 0;
        if (remaining <= length) return { node, offset: remaining };
        remaining -= length;
      }
      const last = textNodes[textNodes.length - 1];
      return last ? { node: last, offset: last.data?.length ?? 0 } : undefined;
    };
    const from = locate(start); const to = locate(end);
    if (!from || !to) return { ok: false, error: 'Matched text container does not expose selectable text nodes.' };
    if (control.isContentEditable === true) control.focus?.();
    const range = element.ownerDocument.createRange();
    range.setStart(from.node, from.offset); range.setEnd(to.node, to.offset);
    const selection = element.ownerDocument.getSelection?.();
    selection?.removeAllRanges(); selection?.addRange(range);
    if (!selection || selection.rangeCount !== 1 || selection.toString().length !== end - start) return { ok: false, error: 'DOM text selection postcondition failed.' };
    return { ok: true, matched: { tag: element.tagName.toLowerCase(), ...before, context }, after: { ...before, selection: { start, end } } };
  }

  if (input.operation === 'verify_value') {
    const actual = element.tagName === 'INPUT' && trim(element.getAttribute('type')).toLowerCase() === 'range'
      ? Number((element as HTMLInputElement).value)
      : Number(element.getAttribute('aria-valuenow') || displayedSliderValue(element));
    const expected = Number(input.value);
    return actual === expected
      ? { ok: true, matched: { tag: element.tagName.toLowerCase(), ...before, context }, after: { ...before, value: String(actual) } }
      : { ok: false, error: 'Slider value postcondition failed.', expected, actual };
  }

  if (input.operation === 'click') {
    // Some accessible tab wrappers delegate activation to a nested anchor. Click
    // that native interactive descendant so browser default behavior is preserved.
    const activation = roleOf(element) === 'tab' ? element.querySelector('a[href],button,[role="tab"]') ?? element : element;
    const activationControl = activation as Element & { focus?: () => void; click?: () => void };
    activationControl.focus?.();
    const point = pointerPoint(activation);
    const hit = activation.ownerDocument?.elementFromPoint?.(point.x, point.y);
    if (hit && hit !== activation && !activation.contains(hit) && !hit.contains(activation)) return { ok: false, error: 'Matched element is obscured at its pointer target.', geometry: point };
    dispatchPointer(activation, 'mousemove', point.x, point.y, 0);
    dispatchPointer(activation, 'mouseover', point.x, point.y, 0);
    dispatchPointer(activation, 'mousedown', point.x, point.y, 1);
    dispatchPointer(activation, 'mouseup', point.x, point.y, 0);
    if (typeof activationControl.click !== 'function') return { ok: false, error: 'Matched element is not clickable.' };
    activationControl.click();
  } else if (input.operation === 'hover') {
    const point = pointerPoint(element);
    dispatchPointer(element, 'mouseover', point.x, point.y, 0);
    dispatchPointer(element, 'mouseenter', point.x, point.y, 0);
    dispatchPointer(element, 'mousemove', point.x, point.y, 0);
  } else if (input.operation === 'drag') {
    const deltaX = Number(input.deltaX);
    const deltaY = Number(input.deltaY);
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || Math.abs(deltaX) > 2000 || Math.abs(deltaY) > 2000 || (deltaX === 0 && deltaY === 0)) return { ok: false, error: 'Drag requires non-zero finite deltaX/deltaY within 2000 CSS pixels.' };
    const start = pointerPoint(element);
    const hit = element.ownerDocument?.elementFromPoint?.(start.x, start.y);
    if (hit && hit !== element && !element.contains(hit) && !hit.contains(element)) return { ok: false, error: 'Drag source is obscured.', geometry: start };
    dispatchPointer(element, 'mousemove', start.x, start.y, 0);
    dispatchPointer(element, 'mousedown', start.x, start.y, 1);
    const steps = Math.max(4, Math.min(20, Math.ceil(Math.hypot(deltaX, deltaY) / 20)));
    for (let step = 1; step <= steps; step += 1) {
      const x = start.x + deltaX * step / steps;
      const y = start.y + deltaY * step / steps;
      const receiver = element.ownerDocument?.elementFromPoint?.(x, y) || element;
      dispatchPointer(receiver, 'mousemove', x, y, 1);
    }
    const endX = start.x + deltaX;
    const endY = start.y + deltaY;
    dispatchPointer(element.ownerDocument?.elementFromPoint?.(endX, endY) || element, 'mouseup', endX, endY, 0);
  } else if (input.operation === 'type') {
    const requestedValue = String(input.value ?? '');
    let value = requestedValue;
    const tag = element.tagName;
    if (!(tag === 'INPUT' || tag === 'TEXTAREA' || control.isContentEditable === true)) return { ok: false, error: 'Matched element is not text-editable.' };
    if (tag === 'INPUT' && trim(element.getAttribute('type') || 'text').toLowerCase() === 'date') {
      const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(requestedValue);
      const human = /^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/.exec(requestedValue);
      const validDate = (year: number, month: number, day: number) => {
        if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month) || !Number.isSafeInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) return false;
        const probe = new Date(Date.UTC(year, month - 1, day));
        return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
      };
      if (iso) {
        const year = Number(iso[1]); const month = Number(iso[2]); const day = Number(iso[3]);
        if (!validDate(year, month, day)) return { ok: false, recoverable: true, error: 'Native date input received an invalid calendar date.' };
      } else if (human) {
        const first = Number(human[1]); const second = Number(human[2]); const year = Number(human[3]);
        const language = trim((element.ownerDocument?.documentElement as Element | undefined)?.getAttribute?.('lang') || element.ownerDocument?.defaultView?.navigator?.language || '').toLowerCase();
        const dayFirstLocale = /^(en-gb|en-au|en-nz|en-in|fr|de|es|it|pt|nl|ru|ja|zh)/.test(language);
        let month: number; let day: number;
        if (first > 12 && second <= 12) { day = first; month = second; }
        else if (second > 12 && first <= 12) { month = first; day = second; }
        else if (first <= 12 && second <= 12 && language) { month = dayFirstLocale ? second : first; day = dayFirstLocale ? first : second; }
        else return { ok: false, recoverable: true, error: 'Native date input requires ISO YYYY-MM-DD or an unambiguous locale-aware date.' };
        if (!validDate(year, month, day)) return { ok: false, recoverable: true, error: 'Native date input received an invalid calendar date.' };
        value = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      } else {
        return { ok: false, recoverable: true, error: 'Native date input requires ISO YYYY-MM-DD or a supported locale-aware numeric date.' };
      }
    }
    control.focus?.();
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      const ctor = tag === 'INPUT' ? view.HTMLInputElement : view.HTMLTextAreaElement;
      const descriptor = ctor ? Object.getOwnPropertyDescriptor(ctor.prototype, 'value') : undefined;
      if (descriptor?.set) descriptor.set.call(element, value);
      else control.value = value;
    } else {
      element.textContent = value;
    }
    const InputEventCtor = view.InputEvent ?? view.Event;
    control.dispatchEvent?.(new InputEventCtor('input', { bubbles: true, ...(view.InputEvent ? { inputType: 'insertText', data: value } : {}) } as InputEventInit));
    control.dispatchEvent?.(new view.Event('change', { bubbles: true }));
    const actual = tag === 'INPUT' || tag === 'TEXTAREA' ? String(control.value ?? '') : trim(element.textContent);
    if (actual !== value) return { ok: false, error: 'Text input postcondition failed.', expected: value, actual };
  } else if (input.operation === 'select') {
    if (element.tagName !== 'SELECT') return { ok: false, error: 'Matched element is not a select control.' };
    const select = element as HTMLSelectElement;
    const requested = Array.isArray(input.value) ? input.value.map((item) => String(item)) : [String(input.value ?? '')];
    if (requested.length < 1 || requested.length > 100) return { ok: false, error: 'Select value list must contain 1-100 entries.' };
    if (!select.multiple && requested.length !== 1) return { ok: false, error: 'Multiple values require a multi-select control.' };
    const desired = new Set(requested);
    const options = Array.from(select.options ?? []);
    const available = new Set(options.flatMap((option) => [String(option.value), trim(option.textContent)]).filter(Boolean));
    const missing = requested.filter((value) => !available.has(value));
    if (missing.length) return { ok: false, error: 'Select option was not found.', missing: missing.slice(0, 20) };
    if (select.multiple) {
      for (const option of options) option.selected = desired.has(String(option.value)) || desired.has(trim(option.textContent));
    } else {
      const value = requested[0]!;
      control.value = value;
      if (String(control.value ?? '') !== value) {
        const option = options.find((candidate) => trim(candidate.textContent) === value);
        if (option) control.value = String(option.value);
      }
    }
    control.dispatchEvent?.(new view.Event('input', { bubbles: true }));
    control.dispatchEvent?.(new view.Event('change', { bubbles: true }));
    const actual = select.multiple
      ? options.filter((option) => option.selected).map((option) => String(option.value || trim(option.textContent)))
      : [String(control.value ?? '')];
    const expectedValues = select.multiple
      ? options.filter((option) => desired.has(String(option.value)) || desired.has(trim(option.textContent))).map((option) => String(option.value || trim(option.textContent)))
      : [String(control.value ?? '')];
    if (actual.length !== expectedValues.length || actual.some((value, index) => value !== expectedValues[index])) {
      return { ok: false, error: 'Select postcondition failed.', expected: expectedValues, actual };
    }
  } else if (input.operation === 'set_value') {
    if (roleOf(element) !== 'slider') return { ok: false, error: 'Matched element is not a slider.' };
    const nativeRange = element.tagName === 'INPUT' && trim(element.getAttribute('type') || '').toLowerCase() === 'range';
    const legacyWidget = isLegacySliderHandle(element);
    const ariaSlider = element.getAttribute('role') === 'slider' || element.hasAttribute('aria-valuenow') || element.hasAttribute('aria-valuemin') || element.hasAttribute('aria-valuemax');
    const slider = element as HTMLInputElement;
    const requested = Number(input.value);
    const current = Number(nativeRange ? slider.value : element.getAttribute('aria-valuenow') || (legacyWidget ? displayedSliderValue(element) : ''));
    const minRaw = nativeRange ? (slider.min || element.getAttribute('aria-valuemin') || '0') : (element.getAttribute('aria-valuemin') || (ariaSlider ? '0' : ''));
    const maxRaw = nativeRange ? (slider.max || element.getAttribute('aria-valuemax') || '100') : (element.getAttribute('aria-valuemax') || (ariaSlider ? '100' : ''));
    const min = minRaw === '' ? undefined : Number(minRaw);
    const max = maxRaw === '' ? undefined : Number(maxRaw);
    const rawStep = nativeRange ? (slider.step || element.getAttribute('aria-valuestep') || '1') : (element.getAttribute('aria-valuestep') || element.getAttribute('step') || '1');
    const step = rawStep === 'any' ? undefined : Number(rawStep);
    if (!Number.isFinite(requested) || !Number.isFinite(current) || (min !== undefined && !Number.isFinite(min)) || (max !== undefined && !Number.isFinite(max)) || (step !== undefined && (!Number.isFinite(step) || step <= 0)) || (min !== undefined && max !== undefined && min > max) || (min !== undefined && requested < min) || (max !== undefined && requested > max)) return { ok: false, error: 'Slider value must be finite, within available bounds, and use a valid step.', min, max, step: rawStep, requested: input.value };
    if (step !== undefined && min !== undefined && Math.abs((requested - min) / step - Math.round((requested - min) / step)) > 1e-8) return { ok: false, error: 'Slider value does not align with the control step.', min, max, step, requested };
    slider.focus();
    if (nativeRange) {
      const descriptor = view.HTMLInputElement ? Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value') : undefined;
      if (descriptor?.set) descriptor.set.call(slider, String(requested)); else slider.value = String(requested);
      slider.dispatchEvent(new view.Event('input', { bubbles: true }));
      slider.dispatchEvent(new view.Event('change', { bubbles: true }));
      if (Number(slider.value) !== requested) return { ok: false, error: 'Slider value postcondition failed.', expected: requested, actual: slider.value };
    } else {
      if (!step || (!ariaSlider && !legacyWidget)) return { ok: false, error: 'Custom slider must expose a discrete value step.' };
      const deltaSteps = Math.abs((requested - current) / step);
      if (!Number.isInteger(Math.round(deltaSteps)) || Math.abs(deltaSteps - Math.round(deltaSteps)) > 1e-8 || deltaSteps > 500) return { ok: false, error: 'Requested slider change exceeds the bounded step limit or does not align with its step.', current, requested, step, maxSteps: 500 };
      const vertical = element.getAttribute('aria-orientation') === 'vertical';
      const key = requested === current ? '' : requested > current ? (vertical ? 'ArrowUp' : 'ArrowRight') : (vertical ? 'ArrowDown' : 'ArrowLeft');
      const pendingKeys = key ? Array.from({ length: Math.round(deltaSteps) }, () => key) : [];
      return { ok: true, matched: { tag: element.tagName.toLowerCase(), ...before, context }, after: before, pendingKeys, expected: requested };
    }
  }

  const finalRect = element.getBoundingClientRect();
  const after = { name: nameOf(element), role: roleOf(element), value: typeof control.value === 'string' ? control.value : '', geometry: { x: finalRect.x, y: finalRect.y, width: finalRect.width, height: finalRect.height } };
  if (input.operation === 'drag') {
    const movedX = finalRect.x - initialRect.x;
    const movedY = finalRect.y - initialRect.y;
    const xMatches = !input.deltaX || Math.sign(movedX) === Math.sign(input.deltaX);
    const yMatches = !input.deltaY || Math.sign(movedY) === Math.sign(input.deltaY);
    if ((!input.deltaX || Math.abs(movedX) < 1) && (!input.deltaY || Math.abs(movedY) < 1) || !xMatches || !yMatches) {
      return { ok: false, error: 'Drag displacement postcondition failed.', expected: { deltaX: input.deltaX, deltaY: input.deltaY }, actual: { deltaX: movedX, deltaY: movedY }, matched: { tag: element.tagName.toLowerCase(), ...before, context } };
    }
  }
  return { ok: true, matched: { tag: element.tagName.toLowerCase(), ...before, context }, after };
}
