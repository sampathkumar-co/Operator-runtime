import type { ActionRequest, ActionResult } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import type { CdpConnection, CdpTarget, JsonMap } from './browser-cdp-connection.ts';

const MAX_AX_NODES = 160;

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

export async function settleAfterInteraction(session: CdpConnection, signal?: AbortSignal): Promise<void> {
  await delay(50, signal);
  try { await waitForReadyState(session, 2_000, signal); } catch (error) {
    if (!(error instanceof OperatorError) || error.code !== 'BROWSER_READY_TIMEOUT') throw error;
  }
}

export async function inspectPage(session: CdpConnection): Promise<{
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
    session.send('Runtime.evaluate', { expression: `(${semanticSnapshotFunction.toString()})()`, returnByValue: true })
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

export function normalizeTargetSpec(input: unknown): { css?: string; text?: string; role?: string; name?: string; renderedColor?: string } {
  const raw = input && typeof input === 'object' ? input as JsonMap : {};
  const clean = (key: string) => typeof raw[key] === 'string' && String(raw[key]).trim() ? String(raw[key]).trim().slice(0, 500) : undefined;
  return { css: clean('css'), text: clean('text'), role: clean('role'), name: clean('name'), renderedColor: clean('renderedColor') };
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
    error: { code: op.code, message: op.message, retryable: op.retryable },
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

export function semanticSnapshotFunction() {
  const trim = (value: unknown, max = 180) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
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
  const visible = (element: Element) => {
    const style = styleOf(element);
    const rect = (element as Element & { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect?.();
    if (style && (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0)) return false;
    return !rect || (rect.width > 0 && rect.height > 0);
  };
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
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((sibling) => sibling.tagName === current!.tagName);
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
  const semanticControls = deepQuery('button,a[href],input,textarea,select,option,summary,[role],[aria-valuenow],[tabindex],[contenteditable="true"]', 160);
  const seenControls = new Set(semanticControls.map(({ element }) => element));
  const pointerControls = deepQuery('*', 240)
    .filter(({ element }) => {
      if (seenControls.has(element) || !visible(element)) return false;
      const style = viewOf(element)?.getComputedStyle?.(element);
      return style?.cursor === 'pointer' && style.pointerEvents !== 'none'
        && !(element as HTMLButtonElement).disabled && element.getAttribute('aria-disabled') !== 'true'
        && Boolean(accessibleName(element));
    })
    .slice(0, 60);
  const controls = [...semanticControls, ...pointerControls]
    .filter(({ element }) => visible(element))
    .map(({ element, context }) => {
      const semanticRole = roleOf(element);
      const role = semanticRole || (viewOf(element)?.getComputedStyle?.(element)?.cursor === 'pointer' ? 'pointer' : '');
      const rect = element.getBoundingClientRect();
      const inputType = element.tagName === 'INPUT' ? trim(element.getAttribute('type') || 'text').toLowerCase() : '';
      const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLOptionElement;
      const readableValue = element.tagName === 'INPUT' && inputType === 'password'
        ? ''
        : ['INPUT', 'TEXTAREA', 'SELECT', 'OPTION'].includes(element.tagName) ? trim((control as HTMLInputElement).value, 500) : '';
      return {
        tag: element.tagName.toLowerCase(),
        selector: selectorOf(element),
        role,
        name: accessibleName(element),
        type: inputType,
        ...(readableValue ? { value: readableValue } : {}),
        ...(['checkbox', 'radio'].includes(inputType) ? { checked: Boolean((element as HTMLInputElement).checked) } : {}),
        ...(element.tagName === 'OPTION' ? { selected: Boolean((element as HTMLOptionElement).selected) } : {}),
        ...(element.tagName === 'SELECT' ? { multiple: Boolean((element as HTMLSelectElement).multiple) } : {}),
        disabled: Boolean((element as HTMLInputElement).disabled || element.getAttribute('aria-disabled') === 'true'),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        ...(semanticRole === 'slider' ? {
          min: trim(element.tagName === 'INPUT' ? (element as HTMLInputElement).min || element.getAttribute('aria-valuemin') || '' : element.getAttribute('aria-valuemin') || ''),
          max: trim(element.tagName === 'INPUT' ? (element as HTMLInputElement).max || element.getAttribute('aria-valuemax') || '' : element.getAttribute('aria-valuemax') || ''),
          step: trim(element.tagName === 'INPUT' ? (element as HTMLInputElement).step || element.getAttribute('aria-valuestep') || '1' : element.getAttribute('aria-valuestep') || element.getAttribute('step') || '1'),
          value: trim(element.tagName === 'INPUT' ? (element as HTMLInputElement).value : element.getAttribute('aria-valuenow') || displayedSliderValue(element))
        } : {}),
        href: element.tagName === 'A' ? trim((element as HTMLAnchorElement).href, 500) : '',
        context
      };
    })
    .filter((item) => (item.role && (item.name || item.role === 'slider')) || item.href)
    .slice(0, 120);
  const visibleText = deepQuery('*', 600)
    .filter(({ element }) => visible(element)
      && Array.from(element.children ?? []).length === 0
      && Boolean(readableText(element)))
    .map(({ element, context }) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        selector: selectorOf(element),
        text: readableText(element),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        context
      };
    })
    .slice(0, 180);
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
  const visuals = deepQuery('*', 600).flatMap(({ element, context }) => {
    if (!visible(element)) return [];
    const style = viewOf(element)?.getComputedStyle?.(element);
    const colors = {
      background: trim(style?.backgroundColor, 64).toLowerCase(),
      fill: trim(style?.fill, 64).toLowerCase(),
      stroke: trim(style?.stroke, 64).toLowerCase()
    };
    const meaningful = Object.values(colors).some((color) => color && color !== 'none' && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)');
    if (!meaningful) return [];
    const rect = element.getBoundingClientRect();
    if (rect.width * rect.height < 16) return [];
    const role = roleOf(element);
    const pointer = style?.cursor === 'pointer' && style.pointerEvents !== 'none';
    return [{ tag: element.tagName.toLowerCase(), selector: selectorOf(element), name: accessibleName(element), role: role || (pointer ? 'pointer' : ''), colors, rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, actionable: Boolean(pointer || role || ['BUTTON', 'A', 'INPUT', 'SUMMARY'].includes(element.tagName)), context }];
  }).slice(0, 120);
  return {
    headings, controls, forms, visuals, visibleText,
    textExcerpt: trim(visibleText.map((item) => item.text).join(' '), 1600)
  };
}

export function interactionFunction(input: { operation: string; target: { css?: string; text?: string; role?: string; name?: string; renderedColor?: string }; value: unknown; deltaX?: number; deltaY?: number }) {
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
  const visible = (element: Element) => {
    const view = element.ownerDocument?.defaultView;
    const style = view?.getComputedStyle?.(element);
    const rect = (element as Element & { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect?.();
    if (style && (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none')) return false;
    return !rect || (rect.width > 0 && rect.height > 0);
  };
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
  const selector = input.target.css || (input.target.renderedColor ? '*' : 'button,a[href],input,textarea,select,option,summary,[role],[aria-valuenow],[tabindex],[contenteditable="true"]');
  const candidates = deepQuery(selector, 1000);
  const desiredColor = input.target.renderedColor ? normalizeColor(input.target.renderedColor) : '';
  let matching = candidates.filter(({ element }) => {
    if (!visible(element)) return false;
    if (input.target.text && !trim(element.textContent).toLowerCase().includes(input.target.text.toLowerCase())) return false;
    if (input.target.role && roleOf(element) !== input.target.role.toLowerCase()) return false;
    if (input.target.name && nameOf(element).toLowerCase() !== input.target.name.toLowerCase()) return false;
    if (desiredColor && !renderedColors(element).includes(desiredColor)) return false;
    return true;
  });
  if (!matching.length && !input.target.css && !input.target.role && !input.target.renderedColor && (input.target.text || input.target.name)) {
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
  if (matching.length > 1) return { ok: false, error: 'Semantic browser target matched multiple elements.', matches: matching.length };
  const match = matching[0];
  if (!match) return { ok: false, error: 'No matching semantic element was found.' };
  const { element, context } = match;
  const control = element as Element & {
    value?: string;
    disabled?: boolean;
    isContentEditable?: boolean;
    focus?: () => void;
    click?: () => void;
    dispatchEvent?: (event: Event) => boolean;
  };
  if (control.disabled === true || element.getAttribute('aria-disabled') === 'true') return { ok: false, error: 'Matched element is disabled.' };
  const initialRect = element.getBoundingClientRect();
  const before = { name: nameOf(element), role: roleOf(element), value: typeof control.value === 'string' ? control.value : '', geometry: { x: initialRect.x, y: initialRect.y, width: initialRect.width, height: initialRect.height } };
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
    const value = String(input.value ?? '');
    const tag = element.tagName;
    if (!(tag === 'INPUT' || tag === 'TEXTAREA' || control.isContentEditable === true)) return { ok: false, error: 'Matched element is not text-editable.' };
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
