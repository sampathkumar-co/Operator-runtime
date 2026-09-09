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

function semanticSnapshotFunction() {
  const trim = (value: unknown, max = 180) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const visible = (element: Element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const accessibleName = (element: Element) => {
    const aria = element.getAttribute('aria-label');
    if (aria) return trim(aria);
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      if (element.labels?.length) return trim(Array.from(element.labels).map((label) => label.textContent).join(' '));
      return trim(element.getAttribute('placeholder') || element.getAttribute('name') || element.id);
    }
    return trim(element.getAttribute('title') || element.textContent);
  };
  const controls = Array.from(document.querySelectorAll('button,a[href],input,textarea,select,[role="button"],[role="link"],[role="textbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="tab"]'))
    .filter(visible)
    .slice(0, 120)
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      role: trim(element.getAttribute('role') || ''),
      name: accessibleName(element),
      type: element instanceof HTMLInputElement ? trim(element.type) : '',
      href: element instanceof HTMLAnchorElement ? trim(element.href, 500) : ''
    }))
    .filter((item) => item.name || item.href);
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]')).filter(visible).slice(0, 60).map((el) => trim(el.textContent)).filter(Boolean);
  const forms = Array.from(document.forms).slice(0, 30).map((form) => ({
    name: trim(form.getAttribute('aria-label') || form.getAttribute('name') || form.id),
    action: trim(form.action, 500),
    fields: Array.from(form.elements).slice(0, 60).map((field) => field instanceof Element ? accessibleName(field) : '').filter(Boolean)
  }));
  return { headings, controls, forms, textExcerpt: trim(document.body?.innerText, 1600) };
}

export function interactionFunction(input: { operation: string; target: { css?: string; text?: string; role?: string; name?: string }; value: unknown }) {
  const trim = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const nameOf = (element: Element) => {
    const aria = element.getAttribute('aria-label');
    if (aria) return trim(aria);
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      if (element.labels?.length) return trim(Array.from(element.labels).map((label) => label.textContent).join(' '));
      return trim(element.getAttribute('placeholder') || element.getAttribute('name') || element.id);
    }
    return trim(element.getAttribute('title') || element.textContent);
  };
  const roleOf = (element: Element) => trim(element.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox' } as Record<string, string>)[element.tagName] || '').toLowerCase();
  const candidates = input.target.css
    ? Array.from(document.querySelectorAll(input.target.css)).slice(0, 100)
    : Array.from(document.querySelectorAll('button,a[href],input,textarea,select,[role],[contenteditable="true"]')).slice(0, 1000);
  const element = candidates.find((candidate) => {
    if (input.target.text && !trim(candidate.textContent).toLowerCase().includes(input.target.text.toLowerCase())) return false;
    if (input.target.role && roleOf(candidate) !== input.target.role.toLowerCase()) return false;
    if (input.target.name && nameOf(candidate).toLowerCase() !== input.target.name.toLowerCase()) return false;
    return true;
  });
  if (!element) return { ok: false, error: 'No matching semantic element was found.' };
  const before = { name: nameOf(element), role: roleOf(element), value: 'value' in element ? String((element as HTMLInputElement).value ?? '') : '' };

  if (input.operation === 'click') {
    if (!(element instanceof HTMLElement)) return { ok: false, error: 'Matched element is not clickable.' };
    element.focus();
    element.click();
  } else if (input.operation === 'type') {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLElement && element.isContentEditable)) {
      return { ok: false, error: 'Matched element is not text-editable.' };
    }
    const value = String(input.value ?? '');
    element.focus();
    if (element instanceof HTMLInputElement) Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
    else if (element instanceof HTMLTextAreaElement) Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(element, value);
    else element.textContent = value;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (input.operation === 'select') {
    if (!(element instanceof HTMLSelectElement)) return { ok: false, error: 'Matched element is not a select control.' };
    element.value = String(input.value ?? '');
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const after = { name: nameOf(element), role: roleOf(element), value: 'value' in element ? String((element as HTMLInputElement).value ?? '') : '' };
  return { ok: true, matched: { tag: element.tagName.toLowerCase(), ...before }, after };
}
