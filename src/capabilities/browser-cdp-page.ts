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
    return actual.origin === expected.origin && (actual.pathname === expected.pathname || actual.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, ''));
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

export async function waitForReadyState(session: CdpConnection, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await pageIdentity(session);
    if (state.readyState === 'interactive' || state.readyState === 'complete') return;
    await delay(75);
  }
  throw new OperatorError('BROWSER_READY_TIMEOUT', 'Timed out waiting for the page to become ready.', { retryable: true });
}

export async function settleAfterInteraction(session: CdpConnection): Promise<void> {
  await delay(50);
  try { await waitForReadyState(session, 2_000); } catch (error) {
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
  return new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'heading', 'navigation', 'main', 'form', 'dialog', 'alert', 'treeitem', 'option']).has(role.toLowerCase());
}

export function normalizeTargetSpec(input: unknown): { css?: string; text?: string; role?: string; name?: string } {
  const raw = input && typeof input === 'object' ? input as JsonMap : {};
  const clean = (key: string) => typeof raw[key] === 'string' && String(raw[key]).trim() ? String(raw[key]).trim().slice(0, 500) : undefined;
  return { css: clean('css'), text: clean('text'), role: clean('role'), name: clean('name') };
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

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

export function semanticSnapshotFunction() {
  const trim = (value: unknown, max = 180) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
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
  const visible = (element: Element) => {
    const view = viewOf(element);
    const style = view?.getComputedStyle?.(element);
    const rect = (element as Element & { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect?.();
    if (style && (style.visibility === 'hidden' || style.display === 'none')) return false;
    return !rect || (rect.width > 0 && rect.height > 0);
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
    return trim(element.getAttribute('placeholder') || element.getAttribute('name') || element.id || element.getAttribute('title') || element.textContent);
  };
  const roleOf = (element: Element) => {
    const explicit = trim(element.getAttribute('role')).toLowerCase();
    if (explicit) return explicit;
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
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    return '';
  };
  const controls = deepQuery('button,a[href],input,textarea,select,option,summary,[role],[contenteditable="true"]', 160)
    .filter(({ element }) => visible(element))
    .map(({ element, context }) => ({
      tag: element.tagName.toLowerCase(),
      role: roleOf(element),
      name: accessibleName(element),
      type: element.tagName === 'INPUT' ? trim(element.getAttribute('type') || 'text') : '',
      href: element.tagName === 'A' ? trim((element as HTMLAnchorElement).href, 500) : '',
      context
    }))
    .filter((item) => item.name || item.href)
    .slice(0, 120);
  const headings = deepQuery('h1,h2,h3,[role="heading"]', 80).filter(({ element }) => visible(element)).map(({ element }) => trim(element.textContent)).filter(Boolean).slice(0, 60);
  const forms = deepQuery('form', 30).map(({ element: form, context }) => {
    const anyForm = form as HTMLFormElement;
    return {
      name: trim(form.getAttribute('aria-label') || form.getAttribute('name') || form.id),
      action: trim(anyForm.action, 500),
      fields: Array.from(anyForm.elements ?? []).slice(0, 60).map((field) => field instanceof Element ? accessibleName(field) : '').filter(Boolean),
      context
    };
  });
  return { headings, controls, forms, textExcerpt: trim(document.body?.innerText, 1600) };
}

export function interactionFunction(input: { operation: string; target: { css?: string; text?: string; role?: string; name?: string }; value: unknown }) {
  const trim = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
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
    return trim(element.getAttribute('placeholder') || element.getAttribute('name') || element.id || element.getAttribute('title') || element.textContent);
  };
  const roleOf = (element: Element) => {
    const explicit = trim(element.getAttribute('role')).toLowerCase();
    if (explicit) return explicit;
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
    if (style && (style.visibility === 'hidden' || style.display === 'none')) return false;
    return !rect || (rect.width > 0 && rect.height > 0);
  };
  const selector = input.target.css || 'button,a[href],input,textarea,select,option,summary,[role],[contenteditable="true"]';
  const candidates = deepQuery(selector, 1000);
  const match = candidates.find(({ element }) => {
    if (!visible(element)) return false;
    if (input.target.text && !trim(element.textContent).toLowerCase().includes(input.target.text.toLowerCase())) return false;
    if (input.target.role && roleOf(element) !== input.target.role.toLowerCase()) return false;
    if (input.target.name && nameOf(element).toLowerCase() !== input.target.name.toLowerCase()) return false;
    return true;
  });
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
  const before = { name: nameOf(element), role: roleOf(element), value: typeof control.value === 'string' ? control.value : '' };
  const view = element.ownerDocument?.defaultView ?? window;

  if (input.operation === 'click') {
    control.focus?.();
    if (typeof control.click !== 'function') return { ok: false, error: 'Matched element is not clickable.' };
    control.click();
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
    const value = String(input.value ?? '');
    control.value = value;
    control.dispatchEvent?.(new view.Event('input', { bubbles: true }));
    control.dispatchEvent?.(new view.Event('change', { bubbles: true }));
    if (String(control.value ?? '') !== value) return { ok: false, error: 'Select postcondition failed.', expected: value, actual: String(control.value ?? '') };
  }

  const after = { name: nameOf(element), role: roleOf(element), value: typeof control.value === 'string' ? control.value : '' };
  return { ok: true, matched: { tag: element.tagName.toLowerCase(), ...before, context }, after };
}
