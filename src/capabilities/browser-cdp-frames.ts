import { OperatorError } from '../core/errors.ts';
import type { CdpConnection, JsonMap } from './browser-cdp-connection.ts';
import { browserDomContractFunction, interactionFunction, semanticSnapshotFunction, unwrapRuntimeValue, type BrowserObservationOptions } from './browser-cdp-page.ts';

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

export function semanticLocatorFunction(target: { ref?: string; css?: string; text?: string; role?: string; name?: string; renderedColor?: string }, contract = browserDomContractFunction(), prepareForPointer = false) {
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
  const eligible = (element: Element) => { const state = contract.stateOf(element); return state.rendered && !state.pointerBlocked && !state.disabled && (!state.inViewport || !state.occluded); };
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
    return {
      coordinateSpace: owner === document ? 'viewport' : 'frame-viewport',
      frameDepth: context.frameDepth,
      x, y, width: rect.width, height: rect.height,
      center: { x: x + rect.width / 2, y: y + rect.height / 2 }
    };
  };
  const scrollStateOf = (element: Element) => {
    const doc = element.ownerDocument;
    const targetElement = (element === doc?.body || element === doc?.documentElement) ? (doc.scrollingElement ?? element) : element;
    const node = targetElement as HTMLElement;
    const top = Number(node.scrollTop); const left = Number(node.scrollLeft);
    const scrollHeight = Number(node.scrollHeight); const scrollWidth = Number(node.scrollWidth);
    const clientHeight = Number(node.clientHeight); const clientWidth = Number(node.clientWidth);
    if (![top, left, scrollHeight, scrollWidth, clientHeight, clientWidth].every(Number.isFinite)) return undefined;
    return { top, left, scrollHeight, scrollWidth, clientHeight, clientWidth, canScrollY: scrollHeight > clientHeight + 1, canScrollX: scrollWidth > clientWidth + 1 };
  };
  const desiredColor = target.renderedColor ? normalizeColor(target.renderedColor) : '';
  const registryKey = Symbol.for('mecord.browser.observed-targets.v2');
  type HistoricalFingerprint = { tag?: string; id?: string; role?: string; semanticName?: string; ariaLabel?: string; name?: string; text?: string };
  const registry = (globalThis as typeof globalThis & { [key: symbol]: { refs?: Map<string, Element>; history?: Map<string, HistoricalFingerprint>; mutationVersion?: number } | undefined })[registryKey];
  const observed = target.ref ? registry?.refs?.get(target.ref) : undefined;
  const historical = target.ref && !observed ? registry?.history?.get(target.ref) : undefined;
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
  const selector = target.css || (desiredColor ? '*' : 'button,a[href],input,textarea,select,option,summary,[role],[aria-valuenow],[tabindex],[contenteditable="true"]');
  let matches = (target.ref
    ? (observed && observed.isConnected !== false
      ? [{ element: observed, context: { frameDepth: observed.ownerDocument === document ? 0 : 1, shadowDepth: 0 } }]
      : historical ? deepQuery('*', 1000).filter(({ element }) => matchesHistorical(element, historical)) : [])
    : deepQuery(selector, 1000)).filter(({ element }) => {
    if (!eligible(element)) return false;
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
  if (!matches.length && !target.ref && !target.css && !target.role && !target.renderedColor && (target.text || target.name)) {
    const desired = (target.name || target.text || '').toLowerCase();
    matches = deepQuery('*', 1000).filter(({ element }) => {
      if (!eligible(element)) return false;
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
  if (target.ref && !observed && matches.length === 1 && registry?.refs instanceof Map) {
    registry.refs.set(target.ref, matches[0]!.element);
  }
  if (prepareForPointer && matches.length === 1) {
    const element = matches[0]!.element;
    (element as HTMLElement).scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
    const state = contract.stateOf(element);
    if (!state.actionable) matches = [];
  }
  return {
    count: matches.length,
    refResolved: target.ref ? Boolean(observed || matches.length === 1) : undefined,
    refHealed: target.ref ? Boolean(!observed && historical && matches.length === 1) : undefined,
    matches: matches.slice(0, 3).map(({ element, context }) => {
      const rect = element.getBoundingClientRect();
      const role = roleOf(element) || (element.ownerDocument?.defaultView?.getComputedStyle?.(element)?.cursor === 'pointer' ? 'pointer' : '');
      const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const type = element.tagName === 'INPUT' ? trim(element.getAttribute('type') || 'text').toLowerCase() : '';
      const readableValue = element.tagName === 'INPUT' && type === 'password' ? '' : typeof control.value === 'string' ? control.value.slice(0, 500) : '';
      const autocomplete = Boolean(
        trim(element.getAttribute('aria-autocomplete'))
        || element.hasAttribute('list')
        || trim(element.getAttribute('role')).toLowerCase() === 'combobox'
        || /(?:^|\s)ui-autocomplete-input(?:\s|$)/i.test(element.getAttribute('class') ?? '')
      );
      return {
      tag: element.tagName.toLowerCase(),
      role,
      name: nameOf(element),
      identity: identityOf(element),
      ...(readableValue ? { value: readableValue } : {}),
      ...(autocomplete ? { autocomplete: true } : {}),
      ...(element.hasAttribute('aria-expanded') ? { expanded: element.getAttribute('aria-expanded') === 'true' } : {}),
      ...(element.hasAttribute('aria-selected') ? { selected: element.getAttribute('aria-selected') === 'true' } : {}),
      ...(element.hasAttribute('aria-checked') ? { checked: element.getAttribute('aria-checked') === 'true' } : {}),
      ...(element.hasAttribute('aria-current') ? { current: trim(element.getAttribute('aria-current')) } : {}),
      active: element.ownerDocument?.activeElement === element,
      actionable: contract.stateOf(element).actionable,
      documentMutationVersion: Number.isSafeInteger(registry?.mutationVersion) ? registry?.mutationVersion : 0,
      ...(scrollStateOf(element) ? { scroll: scrollStateOf(element), scrollable: Boolean(scrollStateOf(element)?.canScrollY || scrollStateOf(element)?.canScrollX) } : {}),
      geometry: geometryOf(element, context),
      context
    }; })
  };
}

export async function inspectOopifFrames(session: CdpConnection, signal: AbortSignal | undefined, observation: BrowserObservationOptions): Promise<{ frames: Array<{
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
            expression: `(${semanticSnapshotFunction.toString()})(${JSON.stringify(observation)}, (${browserDomContractFunction.toString()})())`,
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



export function observedRelativePointFunction(ref: string, xRatio: number, yRatio: number) {
  const registryKey = Symbol.for('mecord.browser.observed-targets.v2');
  const registry = (globalThis as typeof globalThis & { [key: symbol]: { refs?: Map<string, Element> } | undefined })[registryKey];
  const element = registry?.refs?.get(ref);
  if (!element || element.isConnected === false) return { ok: false, stale: true, error: 'Observed browser target is stale.' };
  if (!Number.isFinite(xRatio) || !Number.isFinite(yRatio) || xRatio < 0 || xRatio > 1 || yRatio < 0 || yRatio > 1) {
    return { ok: false, error: 'Relative pointer ratios must be finite values between 0 and 1.' };
  }
  const rect = element.getBoundingClientRect();
  const localX = rect.x + rect.width * xRatio;
  const localY = rect.y + rect.height * yRatio;
  let hit: Element | null = null;
  try { hit = element.ownerDocument?.elementFromPoint?.(localX, localY) ?? null; } catch { hit = null; }
  if (!hit) return { ok: false, error: 'Relative pointer point is not hit-testable in the observed document.' };
  if (hit !== element && !element.contains(hit)) return { ok: false, occluded: true, error: 'Relative pointer point is occluded by another element.' };
  return { ok: true, local: { x: localX, y: localY }, tag: element.tagName.toLowerCase() };
}

export async function observeSemanticTargetState(
  session: CdpConnection,
  target: { ref?: string; css?: string; text?: string; role?: string; name?: string; renderedColor?: string },
  signal?: AbortSignal
): Promise<{ status: 'observed' | 'stale' | 'ambiguous'; sample?: JsonMap; totalMatches: number }> {
  const scope = await attachOopifSessions(session, signal);
  try {
    const contexts: FrameContext[] = [{ kind: 'main' }, ...scope.frames.map((frame): FrameContext => ({ kind: 'oopif', frame }))];
    const expression = `(${semanticLocatorFunction.toString()})(${JSON.stringify(target)}, (${browserDomContractFunction.toString()})())`;
    const samples: JsonMap[] = [];
    let totalMatches = 0;
    for (const context of contexts) {
      try {
        const located = unwrapRuntimeValue(await evaluate(session, context, expression, false, signal)) as JsonMap | undefined;
        const count = typeof located?.count === 'number' ? located.count : 0;
        totalMatches += count;
        const sample = firstLocatedSample(located?.matches);
        if (sample) samples.push(sample);
      } catch {
        if (signal?.aborted) throw abortError();
      }
    }
    if (totalMatches === 0) return { status: 'stale', totalMatches };
    if (totalMatches !== 1 || samples.length !== 1) return { status: 'ambiguous', totalMatches };
    return { status: 'observed', sample: samples[0], totalMatches };
  } finally {
    await scope.stop();
  }
}

export async function performSemanticInteraction(
  session: CdpConnection,
  input: { operation: string; target: { ref?: string; css?: string; text?: string; role?: string; name?: string; renderedColor?: string }; toTarget?: { ref?: string; css?: string; text?: string; role?: string; name?: string; renderedColor?: string }; value: unknown; deltaX?: number; deltaY?: number; xRatio?: number; yRatio?: number; key?: string; keys?: string[]; start?: number; end?: number },
  signal?: AbortSignal
): Promise<{ value: JsonMap; frame?: { targetId: string; url: string; depth: number } }> {
  const scope = await attachOopifSessions(session, signal);
  try {
    const contexts: FrameContext[] = [{ kind: 'main' }, ...scope.frames.map((frame): FrameContext => ({ kind: 'oopif', frame }))];
    const locateExpression = `(${semanticLocatorFunction.toString()})(${JSON.stringify(input.target)}, (${browserDomContractFunction.toString()})())`;
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
      if (input.target.ref) {
        throw new OperatorError('BROWSER_TARGET_STALE', 'Observed browser target is stale or no longer belongs to the observed document; re-observe before retrying.', { retryable: true, details: { target: input.target } });
      }
      throw new OperatorError('BROWSER_ELEMENT_NOT_FOUND', 'No matching semantic element was found.', { retryable: false, details: { target: input.target } });
    }
    if (totalMatches > 1) {
      throw new OperatorError('BROWSER_AMBIGUOUS_ELEMENT', 'Semantic browser target matched multiple elements across page/frame contexts; narrow the selector.', {
        retryable: false,
        details: { target: input.target, totalMatches, contexts: matches.map((match) => ({ count: match.count, frameTargetId: match.context.frame?.targetId, samples: match.samples })) }
      });
    }

    const chosen = matches[0]!.context;
    const sendKey = (params: JsonMap) => chosen.frame
      ? session.sendInSession(chosen.frame.sessionId, 'Input.dispatchKeyEvent', params, 8_000, signal)
      : session.send('Input.dispatchKeyEvent', params, 8_000, signal);
    if (input.operation === 'key_press' || input.operation === 'hotkey') {
      const focusExpression = `(${interactionFunction.toString()})(${JSON.stringify({ ...input, operation: 'focus' })}, (${browserDomContractFunction.toString()})())`;
      const focused = unwrapRuntimeValue(await evaluate(session, chosen, focusExpression, true, signal)) as JsonMap | undefined;
      if (!focused || focused.ok !== true) {
        throw new OperatorError('BROWSER_INTERACTION_FAILED', typeof focused?.error === 'string' ? focused.error : 'Browser target could not be focused before keyboard input.', { retryable: true, details: { target: input.target } });
      }
      const requested = input.operation === 'key_press' ? [String(input.key ?? '')] : Array.isArray(input.keys) ? input.keys.map(String) : [];
      const allowedKeys = new Set(['Enter','Escape','Tab','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Backspace','Delete','Home','End','PageUp','PageDown','Shift','Control','Alt','Meta','a','c','v','b','i','A','C','V','B','I']);
      if (!requested.length || requested.length > 4 || requested.some((key) => !allowedKeys.has(key))) {
        throw new OperatorError('INVALID_BROWSER_KEY', 'Keyboard input must use one supported key or a bounded supported modifier chord.', { retryable: false });
      }
      const modifierBit = (key: string) => key === 'Alt' ? 1 : key === 'Control' ? 2 : key === 'Meta' ? 4 : key === 'Shift' ? 8 : 0;
      const keyMeta = (key: string) => {
        const upper = key.length === 1 ? key.toUpperCase() : key;
        const map: Record<string, [string, number]> = {
          Enter: ['Enter', 13], Escape: ['Escape', 27], Tab: ['Tab', 9], ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38],
          ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40], Backspace: ['Backspace', 8], Delete: ['Delete', 46],
          Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34],
          Shift: ['ShiftLeft', 16], Control: ['ControlLeft', 17], Alt: ['AltLeft', 18], Meta: ['MetaLeft', 91]
        };
        if (key.length === 1) return { key, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) };
        const known = map[key]; return { key, code: known?.[0] ?? key, windowsVirtualKeyCode: known?.[1] ?? 0 };
      };
      let modifiers = 0;
      for (const key of requested) {
        const meta = keyMeta(key); const bit = modifierBit(key);
        modifiers |= bit;
        await sendKey({ type: 'keyDown', ...meta, modifiers });
      }
      for (const key of [...requested].reverse()) {
        const meta = keyMeta(key); const bit = modifierBit(key);
        await sendKey({ type: 'keyUp', ...meta, modifiers });
        modifiers &= ~bit;
      }
      return {
        value: { ok: true, matched: firstLocatedSample(matches[0]!.samples), after: { nativeKeyboardDispatched: true, keys: requested } },
        ...(chosen.frame ? { frame: { targetId: chosen.frame.targetId, url: chosen.frame.url, depth: chosen.frame.depth } } : {})
      };
    }
    if (['click', 'hover', 'drag', 'drag_by', 'resize', 'drag_between', 'click_relative', 'scroll'].includes(input.operation)) {
      const first = firstLocatedSample(matches[0]!.samples);
      const prepareExpression = `(${semanticLocatorFunction.toString()})(${JSON.stringify(input.target)}, (${browserDomContractFunction.toString()})(), true)`;
      const preparedResult = unwrapRuntimeValue(await evaluate(session, chosen, prepareExpression, false, signal)) as JsonMap | undefined;
      const prepared = firstLocatedSample(preparedResult?.matches);
      if (preparedResult?.count !== 1 || !first || !prepared || !sameLocatedIdentity(first, prepared)) {
        throw new OperatorError('BROWSER_STALE_TARGET', 'Semantic target identity changed while scrolling into action position; re-observe before retrying.', {
          retryable: true,
          details: { target: input.target, before: first, after: prepared }
        });
      }
      const confirmed = unwrapRuntimeValue(await evaluate(session, chosen, locateExpression, false, signal)) as JsonMap | undefined;
      const second = firstLocatedSample(confirmed?.matches);
      if (confirmed?.count !== 1 || !second || !sameLocatedTarget(prepared, second)) {
        throw new OperatorError('BROWSER_STALE_TARGET', 'Semantic target identity or geometry changed after scroll and before native input dispatch; re-observe before retrying.', {
          retryable: true,
          details: { target: input.target, before: prepared, after: second }
        });
      }
      const geometry = second.geometry as JsonMap;
      let x = Number(geometry.x) + Number(geometry.width) / 2;
      let y = Number(geometry.y) + Number(geometry.height) / 2;
      if (input.operation === 'click_relative') {
        if (!input.target.ref) throw new OperatorError('INVALID_BROWSER_TARGET', 'click_relative requires an observed target ref.', { retryable: false });
        const xRatio = Number(input.xRatio); const yRatio = Number(input.yRatio);
        const pointExpression = `(${observedRelativePointFunction.toString()})(${JSON.stringify(input.target.ref)}, ${JSON.stringify(xRatio)}, ${JSON.stringify(yRatio)})`;
        const point = unwrapRuntimeValue(await evaluate(session, chosen, pointExpression, false, signal)) as JsonMap | undefined;
        if (!point || point.ok !== true) {
          throw new OperatorError(point?.stale === true ? 'BROWSER_TARGET_STALE' : 'BROWSER_POINT_NOT_ACTIONABLE', typeof point?.error === 'string' ? point.error : 'Relative pointer point is not actionable.', {
            retryable: point?.stale === true,
            details: { target: input.target, xRatio, yRatio, point }
          });
        }
        x = Number(geometry.x) + Number(geometry.width) * xRatio;
        y = Number(geometry.y) + Number(geometry.height) * yRatio;
      }
      if (![x, y, geometry.width, geometry.height].every((value) => Number.isFinite(Number(value))) || Number(geometry.width) <= 0 || Number(geometry.height) <= 0) {
        throw new OperatorError('BROWSER_STALE_TARGET', 'Semantic target geometry is not actionable.', { retryable: true });
      }
      if (input.operation === 'scroll') {
        const scroll = second.scroll && typeof second.scroll === 'object' && !Array.isArray(second.scroll) ? second.scroll as JsonMap : undefined;
        const scrollable = second.scrollable === true || scroll?.canScrollY === true || scroll?.canScrollX === true;
        if (!scrollable) {
          throw new OperatorError('BROWSER_TARGET_NOT_SCROLLABLE', 'Scroll requires an observed scrollable target or page scroller; re-observe and choose a valid scroller.', {
            retryable: true,
            details: { target: input.target }
          });
        }
      }
      let dragDestination: { x: number; y: number; sample: JsonMap } | undefined;
      if (input.operation === 'drag_between') {
        if (!input.target.ref || !input.toTarget?.ref) {
          throw new OperatorError('INVALID_BROWSER_TARGET', 'drag_between requires observed source and destination refs.', { retryable: false });
        }
        const destinationExpression = `(${semanticLocatorFunction.toString()})(${JSON.stringify(input.toTarget)}, (${browserDomContractFunction.toString()})(), true)`;
        const destinationPrepared = unwrapRuntimeValue(await evaluate(session, chosen, destinationExpression, false, signal)) as JsonMap | undefined;
        const destinationFirst = firstLocatedSample(destinationPrepared?.matches);
        if (destinationPrepared?.count !== 1 || !destinationFirst) {
          throw new OperatorError('BROWSER_TARGET_STALE', 'Observed drag destination is stale, ambiguous, or not actionable in the source frame; re-observe before retrying.', {
            retryable: true,
            details: { source: input.target, destination: input.toTarget }
          });
        }
        const sourceReconfirmed = unwrapRuntimeValue(await evaluate(session, chosen, locateExpression, false, signal)) as JsonMap | undefined;
        const sourceAfterDestinationScroll = firstLocatedSample(sourceReconfirmed?.matches);
        if (sourceReconfirmed?.count !== 1 || !sourceAfterDestinationScroll || !sameLocatedIdentity(second, sourceAfterDestinationScroll)) {
          throw new OperatorError('BROWSER_STALE_TARGET', 'Observed drag source changed while preparing the destination; re-observe before retrying.', {
            retryable: true,
            details: { source: input.target, destination: input.toTarget, before: second, after: sourceAfterDestinationScroll }
          });
        }
        const destinationConfirmedExpression = `(${semanticLocatorFunction.toString()})(${JSON.stringify(input.toTarget)}, (${browserDomContractFunction.toString()})())`;
        const destinationConfirmed = unwrapRuntimeValue(await evaluate(session, chosen, destinationConfirmedExpression, false, signal)) as JsonMap | undefined;
        const destinationSecond = firstLocatedSample(destinationConfirmed?.matches);
        if (destinationConfirmed?.count !== 1 || !destinationSecond || !sameLocatedTarget(destinationFirst, destinationSecond)) {
          throw new OperatorError('BROWSER_STALE_TARGET', 'Observed drag destination changed after scroll and before native input dispatch; re-observe before retrying.', {
            retryable: true,
            details: { source: input.target, destination: input.toTarget, before: destinationFirst, after: destinationSecond }
          });
        }
        const sourceGeometry = sourceAfterDestinationScroll.geometry as JsonMap | undefined;
        const destinationGeometry = destinationSecond.geometry as JsonMap | undefined;
        if (!sourceGeometry || !destinationGeometry) throw new OperatorError('BROWSER_STALE_TARGET', 'Drag source or destination geometry is unavailable.', { retryable: true });
        x = Number(sourceGeometry.x) + Number(sourceGeometry.width) / 2;
        y = Number(sourceGeometry.y) + Number(sourceGeometry.height) / 2;
        const destinationX = Number(destinationGeometry.x) + Number(destinationGeometry.width) / 2;
        const destinationY = Number(destinationGeometry.y) + Number(destinationGeometry.height) / 2;
        if (![x, y, destinationX, destinationY].every(Number.isFinite)) {
          throw new OperatorError('BROWSER_STALE_TARGET', 'Drag source or destination geometry is invalid.', { retryable: true });
        }
        dragDestination = { x: destinationX, y: destinationY, sample: destinationSecond };
      }
      const dispatch = (params: JsonMap) => chosen.frame
        ? session.sendInSession(chosen.frame.sessionId, 'Input.dispatchMouseEvent', params, 8_000, signal)
        : session.send('Input.dispatchMouseEvent', params, 8_000, signal);
      if (input.operation === 'hover') {
        await dispatch({ type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
      } else if (input.operation === 'scroll') {
        await dispatch({ type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
        await dispatch({ type: 'mouseWheel', x, y, deltaX: Number(input.deltaX ?? 0), deltaY: Number(input.deltaY ?? 0), button: 'none', buttons: 0 });
      } else if (input.operation === 'click' || input.operation === 'click_relative') {
        await dispatch({ type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
        await dispatch({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        await dispatch({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      } else {
        const targetX = dragDestination ? dragDestination.x : x + Number(input.deltaX);
        const targetY = dragDestination ? dragDestination.y : y + Number(input.deltaY);
        const deltaX = targetX - x; const deltaY = targetY - y;
        await dispatch({ type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
        await dispatch({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        const steps = Math.max(4, Math.min(20, Math.ceil(Math.hypot(deltaX, deltaY) / 20)));
        for (let step = 1; step <= steps; step += 1) {
          await dispatch({ type: 'mouseMoved', x: x + deltaX * step / steps, y: y + deltaY * step / steps, button: 'left', buttons: 1 });
        }
        await dispatch({ type: 'mouseReleased', x: targetX, y: targetY, button: 'left', buttons: 0, clickCount: 1 });
      }
      return {
        value: { ok: true, matched: second, ...(dragDestination ? { destination: dragDestination.sample } : {}), after: { nativeInputDispatched: true } },
        ...(chosen.frame ? { frame: { targetId: chosen.frame.targetId, url: chosen.frame.url, depth: chosen.frame.depth } } : {})
      };
    }
    const expression = `(${interactionFunction.toString()})(${JSON.stringify(input)}, (${browserDomContractFunction.toString()})())`;
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
        await sendKey({ type: 'keyDown', key, code: key, windowsVirtualKeyCode: virtualKey });
        await sendKey({ type: 'keyUp', key, code: key, windowsVirtualKeyCode: virtualKey });
      }
      const verifyExpression = `(${interactionFunction.toString()})(${JSON.stringify({ ...input, operation: 'verify_value' })}, (${browserDomContractFunction.toString()})())`;
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

function sameLocatedIdentity(left: JsonMap, right: JsonMap): boolean {
  return left.identity === right.identity && left.tag === right.tag && left.role === right.role && left.name === right.name;
}

function sameLocatedTarget(left: JsonMap, right: JsonMap): boolean {
  if (!sameLocatedIdentity(left, right)) return false;
  const a = left.geometry as JsonMap | undefined; const b = right.geometry as JsonMap | undefined;
  if (!a || !b) return false;
  return ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(Number(a[key])) && Number.isFinite(Number(b[key])) && Math.abs(Number(a[key]) - Number(b[key])) <= 1);
}
