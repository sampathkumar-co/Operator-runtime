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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attachOopifSessions(session: CdpConnection): Promise<FrameAttachmentScope> {
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
    await session.send('Target.setAutoAttach', AUTO_ATTACH_ON);
  } catch {
    offAttached();
    return { frames: [], async stop() { /* target does not expose child-target auto-attach */ } };
  }

  for (let round = 0; round < MAX_OOPIF_DEPTH; round += 1) {
    await delay(ATTACH_SETTLE_MS);
    const toArm = [...frames.values()].filter((frame) => frame.depth < MAX_OOPIF_DEPTH && !armed.has(frame.sessionId));
    if (toArm.length === 0 && round > 0) break;
    await Promise.allSettled(toArm.map(async (frame) => {
      armed.add(frame.sessionId);
      await session.sendInSession(frame.sessionId, 'Target.setAutoAttach', AUTO_ATTACH_ON);
    }));
  }
  await delay(ATTACH_SETTLE_MS);

  return {
    frames: [...frames.values()].sort((a, b) => a.depth - b.depth || a.targetId.localeCompare(b.targetId)),
    async stop() {
      offAttached();
      const deepestFirst = [...frames.values()].sort((a, b) => b.depth - a.depth);
      await Promise.allSettled(deepestFirst.map((frame) => session.sendInSession(frame.sessionId, 'Target.setAutoAttach', AUTO_ATTACH_OFF)));
      await Promise.allSettled([session.send('Target.setAutoAttach', AUTO_ATTACH_OFF)]);
    }
  };
}

async function evaluate(session: CdpConnection, context: FrameContext, expression: string): Promise<JsonMap> {
  const params = { expression, returnByValue: true, awaitPromise: true, userGesture: false };
  return context.frame
    ? session.sendInSession(context.frame.sessionId, 'Runtime.evaluate', params)
    : session.send('Runtime.evaluate', params);
}

export function semanticLocatorFunction(target: { css?: string; text?: string; role?: string; name?: string }) {
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
  const selector = target.css || 'button,a[href],input,textarea,select,option,summary,[role],[contenteditable="true"]';
  const matches = deepQuery(selector, 1000).filter(({ element }) => {
    if (!visible(element)) return false;
    if (target.text && !trim(element.textContent).toLowerCase().includes(target.text.toLowerCase())) return false;
    if (target.role && roleOf(element) !== target.role.toLowerCase()) return false;
    if (target.name && nameOf(element).toLowerCase() !== target.name.toLowerCase()) return false;
    return true;
  });
  return {
    count: matches.length,
    matches: matches.slice(0, 3).map(({ element, context }) => ({
      tag: element.tagName.toLowerCase(),
      role: roleOf(element),
      name: nameOf(element),
      context
    }))
  };
}

export async function inspectOopifFrames(session: CdpConnection): Promise<Array<{
  targetId: string;
  url: string;
  depth: number;
  title: string;
  readyState: string;
  semantic: unknown;
}>> {
  const scope = await attachOopifSessions(session);
  try {
    const output = [];
    for (const frame of scope.frames) {
      try {
        await Promise.allSettled([
          session.sendInSession(frame.sessionId, 'Runtime.enable'),
          session.sendInSession(frame.sessionId, 'Accessibility.enable')
        ]);
        const [identityResult, semanticResult] = await Promise.all([
          session.sendInSession(frame.sessionId, 'Runtime.evaluate', {
            expression: '({url:location.href,title:document.title,readyState:document.readyState})',
            returnByValue: true
          }),
          session.sendInSession(frame.sessionId, 'Runtime.evaluate', {
            expression: `(${semanticSnapshotFunction.toString()})()`,
            returnByValue: true
          })
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
        // A frame may disappear during navigation. Omit it rather than failing the bounded parent snapshot.
      }
    }
    return output;
  } finally {
    await scope.stop();
  }
}

export async function performSemanticInteraction(
  session: CdpConnection,
  input: { operation: string; target: { css?: string; text?: string; role?: string; name?: string }; value: unknown }
): Promise<{ value: JsonMap; frame?: { targetId: string; url: string; depth: number } }> {
  const scope = await attachOopifSessions(session);
  try {
    const contexts: FrameContext[] = [{ kind: 'main' }, ...scope.frames.map((frame): FrameContext => ({ kind: 'oopif', frame }))];
    const locateExpression = `(${semanticLocatorFunction.toString()})(${JSON.stringify(input.target)})`;
    const matches: Array<{ context: FrameContext; count: number; samples: unknown }> = [];

    for (const context of contexts) {
      try {
        const located = unwrapRuntimeValue(await evaluate(session, context, locateExpression)) as JsonMap | undefined;
        const count = typeof located?.count === 'number' ? located.count : 0;
        if (count > 0) matches.push({ context, count, samples: located?.matches });
      } catch {
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
    const expression = `(${interactionFunction.toString()})(${JSON.stringify(input)})`;
    const value = unwrapRuntimeValue(await evaluate(session, chosen, expression));
    if (!value || typeof value !== 'object') {
      throw new OperatorError('BROWSER_INTERACTION_FAILED', 'Browser interaction returned no semantic result.', { retryable: true });
    }
    return {
      value: value as JsonMap,
      ...(chosen.frame ? { frame: { targetId: chosen.frame.targetId, url: chosen.frame.url, depth: chosen.frame.depth } } : {})
    };
  } finally {
    await scope.stop();
  }
}
