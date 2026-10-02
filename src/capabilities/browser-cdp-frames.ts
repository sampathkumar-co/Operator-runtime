import { OperatorError } from '../core/errors.ts';
import type { CdpConnection, JsonMap } from './browser-cdp-connection.ts';
import { interactionFunction, semanticSnapshotFunction, unwrapRuntimeValue } from './browser-cdp-page.ts';

const MAX_OOPIF_SESSIONS = 16;
const MAX_OOPIF_DEPTH = 4;
const ATTACH_SETTLE_MS = 25;

type AttachedFrame = {
  sessionId: string;
  targetId: string;
  url: string;
  depth: number;
};

type FrameContext = {
  kind: 'main' | 'oopif';
  frame?: AttachedFrame;
};

type FrameAttachmentScope = {
  frames: AttachedFrame[];
  degradedReason?: string;
  stop(): Promise<void>;
};

const AUTO_ATTACH_ON = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true
};

const AUTO_ATTACH_OFF = {
  autoAttach: false,
  waitForDebuggerOnStart: false,
  flatten: true
};

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function attachOopifSessions(session: CdpConnection, signal?: AbortSignal): Promise<FrameAttachmentScope> {
  const frames = new Map<string, AttachedFrame>();
  const depthBySession = new Map<string, number>();
  const armed = new Set<string>();
  const offAttached = session.on('Target.attachedToTarget', (params, parentSessionId) => {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    const targetInfo = params.targetInfo && typeof params.targetInfo === 'object' ? params.targetInfo as JsonMap : undefined;
    const type = typeof targetInfo?.type === 'string' ? targetInfo.type : '';
    if (!sessionId || type !== 'iframe' || frames.has(sessionId) || frames.size >= MAX_OOPIF_SESSIONS) return;
    const parentDepth = parentSessionId ? depthBySession.get(parentSessionId) ?? 0 : 0;
    const depth = parentDepth + 1;
    if (depth > MAX_OOPIF_DEPTH) return;
    const frame: AttachedFrame = {
      sessionId,
      targetId: typeof targetInfo?.targetId === 'string' ? targetInfo.targetId : '',
      url: typeof targetInfo?.url === 'string' ? targetInfo.url.slice(0, 2000) : '',
      depth
    };
    frames.set(sessionId, frame);
    depthBySession.set(sessionId, depth);
  });

  try {
    await session.send('Target.setAutoAttach', AUTO_ATTACH_ON, 8_000, signal);
  } catch {
    offAttached();
    if (signal?.aborted) throw abortError();
    return { frames: [], degradedReason: 'child_target_auto_attach_unavailable', async stop() { /* target does not expose child-target auto-attach */ } };
  }

  const stop = async () => {
      offAttached();
      const deepestFirst = [...frames.values()].sort((a, b) => b.depth - a.depth);
      await Promise.allSettled(deepestFirst.map((frame) => session.sendInSession(frame.sessionId, 'Target.setAutoAttach', AUTO_ATTACH_OFF)));
      await Promise.allSettled([session.send('Target.setAutoAttach', AUTO_ATTACH_OFF)]);
  };
  try {
    for (let round = 0; round < MAX_OOPIF_DEPTH; round += 1) {
      await delay(ATTACH_SETTLE_MS, signal);
      const toArm = [...frames.values()].filter((frame) => frame.depth < MAX_OOPIF_DEPTH && !armed.has(frame.sessionId));
      if (toArm.length === 0 && round > 0) break;
      await Promise.allSettled(toArm.map(async (frame) => {
        armed.add(frame.sessionId);
        await session.sendInSession(frame.sessionId, 'Target.setAutoAttach', AUTO_ATTACH_ON, 8_000, signal);
      }));
      if (signal?.aborted) throw abortError();
    }
    await delay(ATTACH_SETTLE_MS, signal);
    return { frames: [...frames.values()].sort((a, b) => a.depth - b.depth || a.targetId.localeCompare(b.targetId)), stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function evaluate(
  session: CdpConnection,
  context: FrameContext,
  expression: string,
  userGesture = false,
  signal?: AbortSignal
): Promise<JsonMap> {
  const params = { expression, returnByValue: true, awaitPromise: true, userGesture };
  return context.frame
    ? session.sendInSession(context.frame.sessionId, 'Runtime.evaluate', params, 8_000, signal)
    : session.send('Runtime.evaluate', params, 8_000, signal);
}

export function semanticLocatorFunction(target: { css?: string; text?: string; role?: string; name?: string; renderedColor?: string }) {
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
        try { if (element.matches(selector)) found.push({ element, context: { frameDepth, shadowDepth } }); } catch { /* invalid selector becomes no match */ }
        const shadow = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
        if (shadow && shadowDepth < 8) visit(shadow, frameDepth, shadowDepth + 1);
        if (element.tagName === 'IFRAME' && frameDepth < 4) {
          try {
            const frameDocument = (element as HTMLIFrameElement).contentDocument;
            if (frameDocument?.documentElement) visit(frameDocument, frameDepth + 1, shadowDepth);
          } catch { /* cross-origin iframe is handled through an attached CDP target */ }
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
    if ((element as Element & { isConnected?: boolean }).isConnected === false) return false;
    for (let current: Element | null = element; current; current = current.parentElement) {
      if (current.hasAttribute('inert') || current.getAttribute('aria-hidden') === 'true') return false;
    }
    if (style && (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none' || Number(style.opacity) === 0)) return false;
    if (!rect) return true;
    if (rect.width <= 0 || rect.height <= 0) return false;
    const width = Number(view?.innerWidth ?? 0); const height = Number(view?.innerHeight ?? 0);
    return !(width > 0 && height > 0 && (rect.right <= 0 || rect.bottom <= 0 || rect.left >= width || rect.top >= height));
  };
  const identityOf = (element: Element) => {
    const parts: string[] = [];
    let current: Element | null = element;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      const id = current.getAttribute('id');
      if (id) { parts.unshift(`#${id}`); break; }
      const parent = current.parentElement;
      const siblings = parent ? Array.from(parent.children).filter((item) => item.tagName === current!.tagName) : [];
      parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${Math.max(1, siblings.indexOf(current) + 1)})`);
    }
    return parts.join('>');
  };
  const normalizeColor = (raw: string) => {
    const probe = document.createElement?.('span');
    if (!probe) return trim(raw).toLowerCase();
    probe.style.color = ''; probe.style.color = trim(raw);
    if (!probe.style.color) return trim(raw).toLowerCase();
    (document.body || document.documentElement)?.appendChild?.(probe);
    const normalized = probe.ownerDocument?.defaultView?.getComputedStyle?.(probe).color || probe.style.color;
    probe.remove?.();
    return trim(normalized).toLowerCase();
  };
  const desiredColor = target.renderedColor ? normalizeColor(target.renderedColor) : '';
  const selector = target.css || (desiredColor ? '*' : 'button,a[href],input,textarea,select,option,summary,[role],[aria-valuenow],[tabindex],[contenteditable="true"]');
  let matches = deepQuery(selector, 1000).filter(({ element }) => {
    if (!visible(element)) return false;
    if (target.text && !trim(element.textContent).toLowerCase().includes(target.text.toLowerCase())) return false;
    if (target.role && roleOf(element) !== target.role.toLowerCase()) return false;
    if (target.name && nameOf(element).toLowerCase() !== target.name.toLowerCase()) return false;
    if (desiredColor) {
      const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
      const colors = [style?.backgroundColor, style?.fill, style?.stroke].map((value) => trim(value).toLowerCase());
      if (!colors.includes(desiredColor)) return false;
    }
    return true;
  });
  if (!matches.length && !target.css && !target.role && !target.renderedColor && (target.text || target.name)) {
    const desired = (target.name || target.text || '').toLowerCase();
    matches = deepQuery('*', 1000).filter(({ element }) => {
      if (!visible(element)) return false;
      const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
      if (style?.cursor !== 'pointer') return false;
      const name = nameOf(element).toLowerCase();
      return target.name ? name === desired : (name === desired || trim(element.textContent).toLowerCase().includes(desired));
    });
  }
  if (matches.length > 1) {
    const desired = (target.name || target.text || '').toLowerCase();
    const exact = matches.filter(({ element }) => nameOf(element).toLowerCase() === desired);
    if (exact.length === 1) matches = exact;
  }
  return {
    count: matches.length,
    matches: matches.slice(0, 3).map(({ element, context }) => {
      const rect = element.getBoundingClientRect();
      return {
      tag: element.tagName.toLowerCase(),
      role: roleOf(element) || (element.ownerDocument?.defaultView?.getComputedStyle?.(element)?.cursor === 'pointer' ? 'pointer' : ''),
      name: nameOf(element),
      identity: identityOf(element),
      geometry: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      context
    }; })
  };
}

export async function inspectOopifFrames(session: CdpConnection, signal?: AbortSignal): Promise<{ frames: Array<{
  targetId: string;
  url: string;
  depth: number;
  title: string;
  readyState: string;
  semantic: unknown;
}>; degradedReason?: string }> {
  const scope = await attachOopifSessions(session, signal);
  try {
    const output = [];
    for (const frame of scope.frames) {
      try {
        await Promise.allSettled([
          session.sendInSession(frame.sessionId, 'Runtime.enable', {}, 8_000, signal),
          session.sendInSession(frame.sessionId, 'Accessibility.enable', {}, 8_000, signal)
        ]);
        const [identityResult, semanticResult] = await Promise.all([
          session.sendInSession(frame.sessionId, 'Runtime.evaluate', {
            expression: '({url:location.href,title:document.title,readyState:document.readyState})',
            returnByValue: true
          }, 8_000, signal),
          session.sendInSession(frame.sessionId, 'Runtime.evaluate', {
            expression: `(${semanticSnapshotFunction.toString()})()`,
            returnByValue: true
          }, 8_000, signal)
        ]);
        const identity = unwrapRuntimeValue(identityResult) as JsonMap | undefined;
        output.push({
          targetId: frame.targetId,
          url: typeof identity?.url === 'string' ? identity.url.slice(0, 2000) : frame.url,
          depth: frame.depth,
          title: typeof identity?.title === 'string' ? identity.title.slice(0, 500) : '',
          readyState: typeof identity?.readyState === 'string' ? identity.readyState : '',
          semantic: unwrapRuntimeValue(semanticResult) ?? null
        });
      } catch {
        if (signal?.aborted) throw abortError();
        // A frame may disappear during navigation. Omit it rather than failing the bounded parent snapshot.
      }
    }
    return { frames: output, ...(scope.degradedReason ? { degradedReason: scope.degradedReason } : {}) };
  } finally {
    await scope.stop();
  }
}

export async function performSemanticInteraction(
  session: CdpConnection,
  input: { operation: string; target: { css?: string; text?: string; role?: string; name?: string; renderedColor?: string }; value: unknown; deltaX?: number; deltaY?: number },
  signal?: AbortSignal
): Promise<{ value: JsonMap; frame?: { targetId: string; url: string; depth: number } }> {
  const scope = await attachOopifSessions(session, signal);
  try {
    const contexts: FrameContext[] = [{ kind: 'main' }, ...scope.frames.map((frame): FrameContext => ({ kind: 'oopif', frame }))];
    const locateExpression = `(${semanticLocatorFunction.toString()})(${JSON.stringify(input.target)})`;
    const matches: Array<{ context: FrameContext; count: number; samples: unknown }> = [];

    for (const context of contexts) {
      try {
        const located = unwrapRuntimeValue(await evaluate(session, context, locateExpression, false, signal)) as JsonMap | undefined;
        const count = typeof located?.count === 'number' ? located.count : 0;
        if (count > 0) matches.push({ context, count, samples: located?.matches });
      } catch {
        if (signal?.aborted) throw abortError();
        // Cross-origin frame may disappear or deny execution while the page is changing; continue bounded search.
      }
    }

    const totalMatches = matches.reduce((sum, match) => sum + match.count, 0);
    if (totalMatches === 0) {
      throw new OperatorError('BROWSER_ELEMENT_NOT_FOUND', 'No matching semantic element was found.', { retryable: false, details: { target: input.target } });
    }
    if (totalMatches > 1) {
      throw new OperatorError('BROWSER_AMBIGUOUS_ELEMENT', 'Semantic browser target matched multiple elements across page/frame contexts; narrow the selector.', {
        retryable: false,
        details: { target: input.target, totalMatches, contexts: matches.map((match) => ({ count: match.count, frameTargetId: match.context.frame?.targetId, samples: match.samples })) }
      });
    }

    const chosen = matches[0]!.context;
    if (['click', 'hover', 'drag'].includes(input.operation)) {
      const first = firstLocatedSample(matches[0]!.samples);
      const confirmed = unwrapRuntimeValue(await evaluate(session, chosen, locateExpression, false, signal)) as JsonMap | undefined;
      const second = firstLocatedSample(confirmed?.matches);
      if (confirmed?.count !== 1 || !first || !second || !sameLocatedTarget(first, second)) {
        throw new OperatorError('BROWSER_STALE_TARGET', 'Semantic target identity or geometry changed between preflight and native input dispatch; re-observe before retrying.', {
          retryable: true,
          details: { target: input.target, before: first, after: second }
        });
      }
      const geometry = second.geometry as JsonMap;
      const x = Number(geometry.x) + Number(geometry.width) / 2;
      const y = Number(geometry.y) + Number(geometry.height) / 2;
      if (![x, y, geometry.width, geometry.height].every((value) => Number.isFinite(Number(value))) || Number(geometry.width) <= 0 || Number(geometry.height) <= 0) {
        throw new OperatorError('BROWSER_STALE_TARGET', 'Semantic target geometry is not actionable.', { retryable: true });
      }
      const dispatch = (params: JsonMap) => chosen.frame
        ? session.sendInSession(chosen.frame.sessionId, 'Input.dispatchMouseEvent', params, 8_000, signal)
        : session.send('Input.dispatchMouseEvent', params, 8_000, signal);
      if (input.operation === 'hover') {
        await dispatch({ type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
      } else if (input.operation === 'click') {
        await dispatch({ type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
        await dispatch({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        await dispatch({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      } else {
        const deltaX = Number(input.deltaX); const deltaY = Number(input.deltaY);
        await dispatch({ type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
        await dispatch({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        const steps = Math.max(4, Math.min(20, Math.ceil(Math.hypot(deltaX, deltaY) / 20)));
        for (let step = 1; step <= steps; step += 1) {
          await dispatch({ type: 'mouseMoved', x: x + deltaX * step / steps, y: y + deltaY * step / steps, button: 'left', buttons: 1 });
        }
        await dispatch({ type: 'mouseReleased', x: x + deltaX, y: y + deltaY, button: 'left', buttons: 0, clickCount: 1 });
      }
      return {
        value: { ok: true, matched: second, after: { nativeInputDispatched: true } },
        ...(chosen.frame ? { frame: { targetId: chosen.frame.targetId, url: chosen.frame.url, depth: chosen.frame.depth } } : {})
      };
    }
    const expression = `(${interactionFunction.toString()})(${JSON.stringify(input)})`;
    let value = unwrapRuntimeValue(await evaluate(session, chosen, expression, true, signal));
    if (!value || typeof value !== 'object') {
      throw new OperatorError('BROWSER_INTERACTION_FAILED', 'Browser interaction returned no semantic result.', { retryable: true });
    }
    const result = value as JsonMap;
    if (Array.isArray(result.pendingKeys)) {
      for (const inputKey of result.pendingKeys) {
        const key = String(inputKey);
        const virtualKey = key === 'ArrowLeft' ? 37 : key === 'ArrowRight' ? 39 : key === 'ArrowUp' ? 38 : key === 'ArrowDown' ? 40 : 0;
        if (!virtualKey) throw new OperatorError('BROWSER_INTERACTION_FAILED', 'Slider requested an unsupported keyboard input.', { retryable: false });
        await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: virtualKey }, 8_000, signal);
        await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: virtualKey }, 8_000, signal);
      }
      const verifyExpression = `(${interactionFunction.toString()})(${JSON.stringify({ ...input, operation: 'verify_value' })})`;
      const verified = unwrapRuntimeValue(await evaluate(session, chosen, verifyExpression, true, signal));
      if (!verified || typeof verified !== 'object' || (verified as JsonMap).ok !== true) {
        const error = verified && typeof verified === 'object' && typeof (verified as JsonMap).error === 'string'
          ? String((verified as JsonMap).error)
          : 'Slider value postcondition failed.';
        throw new OperatorError('BROWSER_POSTCONDITION_FAILED', error, { retryable: false, details: { target: input.target, expected: result.expected, actual: (verified as JsonMap | undefined)?.actual } });
      }
      value = { ...result, after: (verified as JsonMap).after };
      delete (value as JsonMap).pendingKeys;
    }
    return {
      value: value as JsonMap,
      ...(chosen.frame ? { frame: { targetId: chosen.frame.targetId, url: chosen.frame.url, depth: chosen.frame.depth } } : {})
    };
  } finally {
    await scope.stop();
  }
}

function abortError(): OperatorError {
  return new OperatorError('EXECUTION_ABORTED', 'Browser frame discovery was cancelled.', { retryable: false });
}

function firstLocatedSample(input: unknown): JsonMap | undefined {
  return Array.isArray(input) && input[0] && typeof input[0] === 'object' && !Array.isArray(input[0]) ? input[0] as JsonMap : undefined;
}

function sameLocatedTarget(left: JsonMap, right: JsonMap): boolean {
  if (left.identity !== right.identity || left.tag !== right.tag || left.role !== right.role || left.name !== right.name) return false;
  const a = left.geometry as JsonMap | undefined; const b = right.geometry as JsonMap | undefined;
  if (!a || !b) return false;
  return ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(Number(a[key])) && Number.isFinite(Number(b[key])) && Math.abs(Number(a[key]) - Number(b[key])) <= 1);
}
