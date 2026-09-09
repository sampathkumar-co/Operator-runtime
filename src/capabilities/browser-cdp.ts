import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { CdpConnection, CdpSessionManager, type CdpTarget, type JsonMap } from './browser-cdp-connection.ts';
import {
  assertLoopbackEndpoint,
  collectDiagnostics,
  compactTab,
  failure,
  inspectPage,
  interactionFunction,
  normalizeTargetSpec,
  pageIdentity,
  requirePageTarget,
  requireTarget,
  sameDestination,
  settleAfterInteraction,
  unwrapRuntimeValue,
  validateNavigationUrl,
  waitForReadyState
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

const MAX_TABS = 100;

type DownloadTracker = {
  done: Promise<{ guid: string; state: string; url?: string; suggestedFilename?: string; receivedBytes?: number; totalBytes?: number; filePath?: string }>;
  stop(): void;
};

export class BrowserCdpProvider implements CapabilityProvider {
  readonly name = 'browser.cdp';
  #endpoint: URL;
  #sessions = new CdpSessionManager();
  #browserSession?: CdpConnection;

  constructor(endpoint = 'http://127.0.0.1:9222') {
    this.#endpoint = new URL(endpoint);
    assertLoopbackEndpoint(this.#endpoint);
  }

  supports(action: ActionRequest): boolean {
    return ['browser.inspect', 'browser.navigate', 'browser.interact', 'browser.tab.focus', 'browser.tab.close'].includes(action.capability);
  }

  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const started = performance.now();
    try {
      if (action.capability === 'browser.inspect') return await this.#inspect(action, started);
      if (action.capability === 'browser.navigate') return await this.#navigate(action, started);
      if (action.capability === 'browser.interact') return await this.#interact(action, started);
      if (action.capability === 'browser.tab.focus') return await this.#focusTab(action, started);
      if (action.capability === 'browser.tab.close') return await this.#closeTab(action, started);
      throw new OperatorError('UNSUPPORTED_ACTION', action.capability);
    } catch (error) {
      return failure(action, this.name, started, error);
    }
  }

  close(): void {
    this.#sessions.closeAll();
    this.#browserSession?.close();
    this.#browserSession = undefined;
  }

  async #inspect(action: ActionRequest, started: number): Promise<ActionResult> {
    const tabs = await this.#listTargets();
    const targetId = typeof action.input.targetId === 'string' ? action.input.targetId : undefined;
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
    const page = await inspectPage(session);
    return {
      ok: true,
      capability: action.capability,
      provider: this.name,
      output: { target: compactTab(target), page },
      evidence: [
        evidence('browser_state', 'pass', 'Semantic page state inspected through CDP.', { targetId }),
        evidence('data_minimization', 'pass', 'Returned a bounded accessibility/DOM summary instead of raw page HTML.', { accessibilityNodes: page.accessibility.length })
      ],
      durationMs: Math.round(performance.now() - started)
    };
  }

  async #navigate(action: ActionRequest, started: number): Promise<ActionResult> {
    const url = validateNavigationUrl(String(action.input.url ?? ''));
    const newTab = action.input.newTab === true;
    const requestedTargetId = typeof action.input.targetId === 'string' ? action.input.targetId : undefined;

    let target: CdpTarget;
    if (newTab) {
      target = await this.#createTarget(url);
    } else {
      const tabs = await this.#listTargets();
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
      await waitForReadyState(session, 10_000);
      const state = await pageIdentity(session);
      if (!sameDestination(state.url, url)) {
        throw new OperatorError('BROWSER_POSTCONDITION_FAILED', 'Browser did not reach the requested destination.', { retryable: true, details: { requested: url, actual: state.url } });
      }
      return {
        ok: true,
        capability: action.capability,
        provider: this.name,
        output: { targetId: target.id, requestedUrl: url, ...state, diagnostics: diagnostics.snapshot() },
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

  async #focusTab(action: ActionRequest, started: number): Promise<ActionResult> {
    const targetId = String(action.input.targetId ?? '');
    if (!targetId) throw new OperatorError('INVALID_BROWSER_TARGET', 'targetId is required.');
    const tabs = await this.#listTargets();
    const target = requireTarget(tabs, targetId);
    const response = await fetch(new URL(`/json/activate/${encodeURIComponent(targetId)}`, this.#endpoint), {
      signal: AbortSignal.timeout(3_000)
    });
    if (!response.ok) throw new OperatorError('CDP_ACTIVATE_TAB_FAILED', `CDP returned HTTP ${response.status} while focusing a tab.`, { retryable: true });
    const session = this.#sessions.get(target);
    const result = await session.send('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true });
    const visibilityState = unwrapRuntimeValue(result);
    if (visibilityState !== 'visible') {
      throw new OperatorError('BROWSER_POSTCONDITION_FAILED', 'Target did not become visible after activation.', { retryable: true, details: { targetId, visibilityState } });
    }
    return {
      ok: true,
      capability: action.capability,
      provider: this.name,
      output: { targetId, visibilityState },
      evidence: [
        evidence('browser_tab_focus', 'pass', 'Browser target activation command completed.', { targetId }),
        evidence('postcondition', 'pass', 'Target document reports visible state after activation.', { targetId, visibilityState })
      ],
      durationMs: Math.round(performance.now() - started)
    };
  }

  async #closeTab(action: ActionRequest, started: number): Promise<ActionResult> {
    const targetId = String(action.input.targetId ?? '');
    if (!targetId) throw new OperatorError('INVALID_BROWSER_TARGET', 'targetId is required.');
    requireTarget(await this.#listTargets(), targetId);
    const response = await fetch(new URL(`/json/close/${encodeURIComponent(targetId)}`, this.#endpoint), {
      signal: AbortSignal.timeout(3_000)
    });
    if (!response.ok) throw new OperatorError('CDP_CLOSE_TAB_FAILED', `CDP returned HTTP ${response.status} while closing a tab.`, { retryable: true });
    this.#sessions.forget(targetId);
    const remaining = await this.#listTargets();
    if (remaining.some((item) => item.id === targetId)) {
      throw new OperatorError('BROWSER_POSTCONDITION_FAILED', 'Target still exists after close command.', { retryable: true, details: { targetId } });
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

  async #interact(action: ActionRequest, started: number): Promise<ActionResult> {
    const targetId = String(action.input.targetId ?? '');
    if (!targetId) throw new OperatorError('INVALID_BROWSER_TARGET', 'targetId is required.');
    const operation = String(action.input.operation ?? '');
    if (!['click', 'type', 'select'].includes(operation)) throw new OperatorError('INVALID_BROWSER_OPERATION', 'operation must be click, type, or select.');

    const targetSpec = normalizeTargetSpec(action.input.target);
    if (!targetSpec.css && !targetSpec.text && !(targetSpec.role && targetSpec.name)) {
      throw new OperatorError('INVALID_BROWSER_TARGET', 'Provide css, text, or role+name for semantic targeting.');
    }

    const tabs = await this.#listTargets();
    const target = requireTarget(tabs, targetId);
    const session = this.#sessions.get(target);
    const diagnostics = await collectDiagnostics(session);
    const expectDownload = action.input.expectDownload === true;
    let download: DownloadTracker | undefined;
    try {
      await session.send('Runtime.enable');
      if (expectDownload) {
        if (operation !== 'click') throw new OperatorError('INVALID_DOWNLOAD_INTERACTION', 'expectDownload is only valid for click operations.');
        download = await this.#prepareDownload(Math.min(Math.max(Number(action.input.downloadTimeoutMs ?? 30_000), 1_000), 10 * 60_000));
      }
      const before = await pageIdentity(session);
      const expression = `(${interactionFunction.toString()})(${JSON.stringify({ operation, target: targetSpec, value: action.input.value ?? null })})`;
      const result = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      const value = unwrapRuntimeValue(result);
      if (!value || typeof value !== 'object' || (value as JsonMap).ok !== true) {
        const message = value && typeof value === 'object' && typeof (value as JsonMap).error === 'string'
          ? String((value as JsonMap).error)
          : 'Browser interaction did not complete.';
        throw new OperatorError('BROWSER_ELEMENT_NOT_FOUND', message, { retryable: false, details: { target: targetSpec } });
      }
      await settleAfterInteraction(session);
      const after = await pageIdentity(session);
      const downloadResult = download ? await download.done : undefined;
      if (downloadResult?.state === 'canceled') {
        throw new OperatorError('BROWSER_DOWNLOAD_CANCELED', 'Browser download was canceled.', { retryable: true, details: downloadResult });
      }
      const evidenceItems = [
        evidence('browser_interaction', 'pass', `Semantic browser ${operation} executed through CDP.`, { targetId, matched: (value as JsonMap).matched }),
        evidence('postcondition', 'pass', 'Element state was re-read after the interaction.', { after: (value as JsonMap).after, pageUrl: after.url })
      ];
      if (downloadResult) evidenceItems.push(evidence('download_complete', 'pass', 'Browser emitted a completed download event.', downloadResult));
      return {
        ok: true,
        capability: action.capability,
        provider: this.name,
        output: { targetId, operation, matched: (value as JsonMap).matched, before, after, ...(downloadResult ? { download: downloadResult } : {}), diagnostics: diagnostics.snapshot() },
        evidence: evidenceItems,
        durationMs: Math.round(performance.now() - started)
      };
    } finally {
      diagnostics.stop();
      download?.stop();
    }
  }

  async #browserConnection(): Promise<CdpConnection> {
    if (this.#browserSession && !this.#browserSession.closed) return this.#browserSession;
    const response = await fetch(new URL('/json/version', this.#endpoint), { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new OperatorError('CDP_HTTP_ERROR', `CDP returned HTTP ${response.status} while discovering browser endpoint.`, { retryable: true });
    const version = await response.json() as Record<string, unknown>;
    const ws = typeof version.webSocketDebuggerUrl === 'string' ? version.webSocketDebuggerUrl : '';
    if (!ws) throw new OperatorError('CDP_BROWSER_TARGET_UNAVAILABLE', 'Browser does not expose a browser-level DevTools WebSocket endpoint.', { retryable: true });
    this.#browserSession = new CdpConnection('browser', ws);
    return this.#browserSession;
  }

  async #prepareDownload(timeoutMs: number): Promise<DownloadTracker> {
    const browser = await this.#browserConnection();
    await browser.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
    let activeGuid: string | undefined;
    let meta: { url?: string; suggestedFilename?: string } = {};
    let settled = false;
    let resolveDone!: (value: { guid: string; state: string; url?: string; suggestedFilename?: string; receivedBytes?: number; totalBytes?: number; filePath?: string }) => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<{ guid: string; state: string; url?: string; suggestedFilename?: string; receivedBytes?: number; totalBytes?: number; filePath?: string }>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    const timer = setTimeout(() => {
      if (!settled) rejectDone(new OperatorError('BROWSER_DOWNLOAD_TIMEOUT', `No completed download event arrived within ${timeoutMs}ms.`, { retryable: true }));
    }, timeoutMs);
    const offBegin = browser.on('Browser.downloadWillBegin', (params) => {
      if (activeGuid) return;
      activeGuid = typeof params.guid === 'string' ? params.guid : undefined;
      meta = {
        url: typeof params.url === 'string' ? params.url.slice(0, 2000) : undefined,
        suggestedFilename: typeof params.suggestedFilename === 'string' ? params.suggestedFilename.slice(0, 500) : undefined
      };
    });
    const offProgress = browser.on('Browser.downloadProgress', (params) => {
      const guid = typeof params.guid === 'string' ? params.guid : '';
      const state = typeof params.state === 'string' ? params.state : '';
      if (!guid || (activeGuid && guid !== activeGuid) || !['completed', 'canceled'].includes(state)) return;
      activeGuid = activeGuid ?? guid;
      settled = true;
      clearTimeout(timer);
      resolveDone({
        guid,
        state,
        ...meta,
        receivedBytes: typeof params.receivedBytes === 'number' ? params.receivedBytes : undefined,
        totalBytes: typeof params.totalBytes === 'number' ? params.totalBytes : undefined,
        filePath: typeof params.filePath === 'string' ? params.filePath.slice(0, 2000) : undefined
      });
    });
    return { done, stop: () => { clearTimeout(timer); offBegin(); offProgress(); } };
  }

  async #listTargets(): Promise<CdpTarget[]> {
    const response = await fetch(new URL('/json/list', this.#endpoint), { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new OperatorError('CDP_HTTP_ERROR', `CDP returned HTTP ${response.status}.`, { retryable: true });
    const raw = await response.json() as Array<Record<string, unknown>>;
    return raw.slice(0, MAX_TABS).map((tab) => ({
      id: String(tab.id ?? ''),
      type: typeof tab.type === 'string' ? tab.type : undefined,
      title: typeof tab.title === 'string' ? tab.title : undefined,
      url: typeof tab.url === 'string' ? tab.url : undefined,
      webSocketDebuggerUrl: typeof tab.webSocketDebuggerUrl === 'string' ? tab.webSocketDebuggerUrl : undefined
    })).filter((tab) => tab.id.length > 0);
  }

  async #createTarget(url: string): Promise<CdpTarget> {
    const endpoint = new URL('/json/new', this.#endpoint);
    endpoint.search = url;
    const response = await fetch(endpoint, { method: 'PUT', signal: AbortSignal.timeout(4_000) });
    if (!response.ok) throw new OperatorError('CDP_CREATE_TAB_FAILED', `CDP returned HTTP ${response.status} while creating a tab.`, { retryable: true });
    const tab = await response.json() as Record<string, unknown>;
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

// Backward-compatible M0 name.
export class BrowserCdpInspectProvider extends BrowserCdpProvider {}
