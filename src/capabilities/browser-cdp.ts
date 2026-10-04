import type { ActionRequest, ActionResult, CapabilityExecutionContext, CapabilityProvider, CapabilityScore, ProviderReconciliationResult } from '../core/types.ts';
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

const MAX_TABS = 100;

type DownloadTracker = {
  done: Promise<{ guid: string; state: string; url?: string; suggestedFilename?: string; receivedBytes?: number; totalBytes?: number; filePath?: string }>;
  stop(): void;
};

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
      const caught = context.signal?.aborted ? abortError() : error;
      const normalized = action.capability === 'browser.interact'
        && caught instanceof OperatorError
        && ['BROWSER_TARGET_STALE', 'BROWSER_STALE_TARGET', 'BROWSER_TARGET_NOT_FOUND', 'BROWSER_TARGET_NOT_SCROLLABLE'].includes(caught.code)
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
        const requestedUrl = validateNavigationUrl(String(action.input.url ?? ''));
        const tabs = await this.#listTargets(context.signal);
        const requestedTargetId = typeof action.input.targetId === 'string' ? action.input.targetId : undefined;
        if (requestedTargetId) {
          const target = tabs.find((item) => item.id === requestedTargetId);
          if (target && typeof target.url === 'string' && sameDestination(target.url, requestedUrl)) {
            return browserReconciled(action, this.name, 'Fresh target discovery proves the requested browser destination.', {
              targetId: target.id, url: target.url, title: target.title
            });
          }
          return browserReconciliation('uncertain', 'The requested browser target does not currently prove the navigation outcome.');
        }
        const matches = tabs.filter((item) => item.type === 'page' && typeof item.url === 'string' && sameDestination(item.url, requestedUrl));
        if (matches.length === 1) {
          const target = matches[0]!;
          return browserReconciled(action, this.name, 'Fresh browser discovery found one page at the requested destination.', {
            targetId: target.id, url: target.url, title: target.title
          });
        }
        return browserReconciliation('uncertain', matches.length === 0
          ? 'No current page proves the requested navigation outcome.'
          : 'Multiple pages match the requested destination, so the original navigation target is ambiguous.');
      }

      if (action.capability === 'browser.tab.close') {
        const targetId = String(action.input.targetId ?? '');
        if (!targetId) return browserReconciliation('uncertain', 'Tab-close reconciliation requires targetId.');
        const exists = (await this.#listTargets(context.signal)).some((item) => item.id === targetId);
        return exists
          ? browserReconciliation('not_applied', 'The exact browser target still exists.')
          : browserReconciled(action, this.name, 'Fresh target discovery proves the requested browser target is closed.', { targetId, closed: true });
      }

      if (action.capability === 'browser.tab.focus') {
        const targetId = String(action.input.targetId ?? '');
        if (!targetId) return browserReconciliation('uncertain', 'Tab-focus reconciliation requires targetId.');
        const tabs = await this.#listTargets(context.signal);
        const target = tabs.find((item) => item.id === targetId);
        if (!target) return browserReconciliation('uncertain', 'Focused target no longer exists.');
        const session = this.#sessions.get(target);
        const evaluated = await session.send('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true });
        const visibilityState = unwrapRuntimeValue(evaluated);
        return visibilityState === 'visible'
          ? browserReconciled(action, this.name, 'Target document reports visible state during reconciliation.', { targetId, visibilityState })
          : browserReconciliation('not_applied', 'Target document is not visible during reconciliation.');
      }

      if (action.capability === 'browser.interact') {
        const targetId = String(action.input.targetId ?? '');
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
        if (!verification.ok) {
          return browserReconciliation('uncertain', 'Explicit browser post-state verification did not prove the interaction outcome.');
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
    const tabs = await this.#listTargets(signal);
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
    const observation = normalizeObservationOptions(action.input.observation);
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
    const url = validateNavigationUrl(String(action.input.url ?? ''));
    const newTab = action.input.newTab === true;
    const requestedTargetId = typeof action.input.targetId === 'string' ? action.input.targetId : undefined;

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
    const targetId = String(action.input.targetId ?? '');
    if (!targetId) throw new OperatorError('INVALID_BROWSER_TARGET', 'targetId is required.');
    const tabs = await this.#listTargets(signal);
    const target = requireTarget(tabs, targetId);
    const response = await fetch(new URL(`/json/activate/${encodeURIComponent(targetId)}`, this.#endpoint), {
      redirect: 'error',
      signal: combinedSignal(signal, 3_000)
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

  async #closeTab(action: ActionRequest, started: number, signal?: AbortSignal): Promise<ActionResult> {
    const targetId = String(action.input.targetId ?? '');
    if (!targetId) throw new OperatorError('INVALID_BROWSER_TARGET', 'targetId is required.');
    requireTarget(await this.#listTargets(signal), targetId);
    const response = await fetch(new URL(`/json/close/${encodeURIComponent(targetId)}`, this.#endpoint), {
      redirect: 'error',
      signal: combinedSignal(signal, 3_000)
    });
    if (!response.ok) throw new OperatorError('CDP_CLOSE_TAB_FAILED', `CDP returned HTTP ${response.status} while closing a tab.`, { retryable: true });
    this.#sessions.forget(targetId);
    const remaining = await this.#listTargets(signal);
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

  async #verify(action: ActionRequest, started: number, signal?: AbortSignal): Promise<ActionResult> {
    const targetId = String(action.input.targetId ?? '');
    if (!targetId) throw new OperatorError('INVALID_BROWSER_TARGET', 'targetId is required.');
    const rawExpect = action.input.expect && typeof action.input.expect === 'object' && !Array.isArray(action.input.expect)
      ? action.input.expect as JsonMap
      : {};
    const targetProvided = action.input.target && typeof action.input.target === 'object' && !Array.isArray(action.input.target);
    const targetSpec = targetProvided ? normalizeTargetSpec(action.input.target) : undefined;
    if (targetSpec && !targetSpec.ref && !targetSpec.css && !targetSpec.text && !targetSpec.renderedColor && !(targetSpec.role && targetSpec.name)) {
      throw new OperatorError('INVALID_BROWSER_TARGET', 'Verification target must use an observed ref, css, text, renderedColor, or role+name.');
    }
    const expectationKeys = ['exists', 'value', 'checked', 'selected', 'expanded', 'current', 'active', 'urlContains', 'titleContains', 'textContains'];
    if (!expectationKeys.some((key) => rawExpect[key] !== undefined)) {
      throw new OperatorError('INVALID_BROWSER_VERIFICATION', 'At least one bounded verification expectation is required.');
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
        checks.push({ field: 'exists', expected: rawExpect.exists ?? true, actual: false, pass: rawExpect.exists === false });
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
    const targetId = String(action.input.targetId ?? '');
    if (!targetId) throw new OperatorError('INVALID_BROWSER_TARGET', 'targetId is required.');
    const operation = String(action.input.operation ?? '');
    if (!['click', 'hover', 'drag', 'drag_by', 'resize', 'drag_between', 'click_relative', 'scroll', 'type', 'select', 'set_value', 'select_date', 'key_press', 'hotkey', 'keyboard_text', 'select_text_range'].includes(operation)) throw new OperatorError('INVALID_BROWSER_OPERATION', 'operation is not a supported bounded browser interaction.');

    const targetSpec = normalizeTargetSpec(action.input.target);
    if (!targetSpec.ref && !targetSpec.css && !targetSpec.text && !targetSpec.renderedColor && !(targetSpec.role && targetSpec.name)) {
      throw new OperatorError('INVALID_BROWSER_TARGET', 'Provide an observed ref, css, text, renderedColor, or role+name for semantic targeting.');
    }
    const toTargetSpec = operation === 'drag_between' ? normalizeTargetSpec(action.input.toTarget) : undefined;
    if (operation === 'drag_between' && (!targetSpec.ref || !toTargetSpec?.ref)) {
      throw new OperatorError('INVALID_BROWSER_TARGET', 'drag_between requires observed source and destination refs from the same current observation context.');
    }
    const deltaOperation = ['drag', 'drag_by', 'resize', 'scroll'].includes(operation);
    const deltaX = deltaOperation ? Number(action.input.deltaX ?? 0) : undefined;
    const deltaY = deltaOperation ? Number(action.input.deltaY ?? 0) : undefined;
    if (deltaOperation && (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || Math.abs(deltaX!) > 2000 || Math.abs(deltaY!) > 2000 || (deltaX === 0 && deltaY === 0))) {
      throw new OperatorError(operation === 'scroll' ? 'INVALID_BROWSER_SCROLL' : 'INVALID_BROWSER_DRAG', 'Drag/resize/scroll requires non-zero finite deltaX/deltaY within 2000 CSS pixels.');
    }
    if (operation === 'scroll' && !targetSpec.ref) throw new OperatorError('INVALID_BROWSER_TARGET', 'scroll requires an observed target ref.');
    if (operation === 'keyboard_text') {
      const text = String(action.input.value ?? '');
      if (!targetSpec.ref) throw new OperatorError('INVALID_BROWSER_TARGET', 'keyboard_text requires an observed target ref.');
      if (!text.length || text.length > 4096 || Buffer.byteLength(text, 'utf8') > 16 * 1024) throw new OperatorError('INVALID_BROWSER_TEXT', 'keyboard_text requires 1-4096 characters and at most 16 KiB UTF-8.');
    }
    if (operation === 'select_date') {
      const requestedDate = String(action.input.value ?? '');
      if (!targetSpec.ref) throw new OperatorError('INVALID_BROWSER_TARGET', 'select_date requires an observed target ref.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) throw new OperatorError('INVALID_BROWSER_DATE', 'select_date requires an ISO YYYY-MM-DD value.');
    }
    const hasRatioPoint = operation === 'click_relative' && (action.input.xRatio !== undefined || action.input.yRatio !== undefined);
    const hasPixelPoint = operation === 'click_relative' && (action.input.xPx !== undefined || action.input.yPx !== undefined);
    const xRatio = hasRatioPoint ? Number(action.input.xRatio) : undefined;
    const yRatio = hasRatioPoint ? Number(action.input.yRatio) : undefined;
    const xPx = hasPixelPoint ? Number(action.input.xPx) : undefined;
    const yPx = hasPixelPoint ? Number(action.input.yPx) : undefined;
    if (operation === 'click_relative' && (
      !targetSpec.ref || hasRatioPoint === hasPixelPoint
      || (hasRatioPoint && (!Number.isFinite(xRatio) || !Number.isFinite(yRatio) || xRatio! < 0 || xRatio! > 1 || yRatio! < 0 || yRatio! > 1))
      || (hasPixelPoint && (!Number.isFinite(xPx) || !Number.isFinite(yPx) || xPx! < 0 || yPx! < 0 || xPx! > 2000 || yPx! > 2000))
    )) {
      throw new OperatorError('INVALID_BROWSER_POINT', 'click_relative requires an observed ref and exactly one bounded coordinate pair: xRatio/yRatio in [0,1] or non-negative xPx/yPx within 2000 CSS pixels.');
    }

    const tabs = await this.#listTargets(signal);
    const target = requireTarget(tabs, targetId);
    const session = this.#sessions.get(target);
    const diagnostics = await collectDiagnostics(session);
    const expectDownload = action.input.expectDownload === true;
    let download: DownloadTracker | undefined;
    try {
      await session.send('Runtime.enable');
      if (expectDownload) {
        if (operation !== 'click') throw new OperatorError('INVALID_DOWNLOAD_INTERACTION', 'expectDownload is only valid for click operations.');
        const frameTree = await session.send('Page.getFrameTree');
        const frameIds = collectFrameIds(frameTree.frameTree);
        if (frameIds.size === 0) throw new OperatorError('BROWSER_DOWNLOAD_CORRELATION_UNAVAILABLE', 'The initiating target did not expose a frame identity for download correlation.');
        download = await this.#prepareDownload(
          Math.min(Math.max(Number(action.input.downloadTimeoutMs ?? 30_000), 1_000), 10 * 60_000),
          targetId,
          frameIds,
          signal
        );
      }
      const before = await pageIdentity(session);
      const interaction = await performSemanticInteraction(session, {
        operation,
        target: targetSpec,
        ...(toTargetSpec ? { toTarget: toTargetSpec } : {}),
        value: action.input.value ?? null,
        ...(deltaOperation ? { deltaX, deltaY } : {}),
        ...(operation === 'click_relative' && hasRatioPoint ? { xRatio, yRatio } : {}),
        ...(operation === 'click_relative' && hasPixelPoint ? { xPx, yPx } : {}),
        ...(operation === 'key_press' ? { key: String(action.input.key ?? '') } : {}),
        ...(operation === 'hotkey' ? { keys: Array.isArray(action.input.keys) ? action.input.keys.map(String) : [] } : {}),
        ...(operation === 'select_text_range' ? { start: Number(action.input.start), end: Number(action.input.end) } : {})
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
      const matchedAutocomplete = Boolean(value.matched && typeof value.matched === 'object' && (value.matched as JsonMap).autocomplete === true);
      const settle = await settleAfterInteraction(session, signal, operation === 'type' && matchedAutocomplete ? 350 : 50);
      throwIfAborted(signal);
      const after = await pageIdentity(session);
      const afterTarget = await observeSemanticTargetState(session, targetSpec, signal);
      const beforeTarget = value.matched && typeof value.matched === 'object' ? value.matched as JsonMap : {};
      const compactTarget = (sample: JsonMap | undefined) => sample ? {
        identity: sample.identity, role: sample.role, name: sample.name, value: sample.value,
        checked: sample.checked, selected: sample.selected, expanded: sample.expanded, current: sample.current,
        active: sample.active, scroll: sample.scroll, geometry: sample.geometry, localTreeState: sample.subtreeSignature
      } : null;
      const beforeRelevant = { page: { url: before.url, title: before.title }, target: compactTarget(beforeTarget) };
      const afterRelevant = {
        page: { url: after.url, title: after.title },
        target: afterTarget.status === 'observed' ? compactTarget(afterTarget.sample) : { status: afterTarget.status }
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
      const downloadResult = download ? await download.done : undefined;
      if (downloadResult?.state === 'canceled') {
        throw new OperatorError('BROWSER_DOWNLOAD_CANCELED', 'Browser download was canceled.', { retryable: true, details: downloadResult });
      }
      const stateProgress = downloadResult?.state === 'completed' || directSemanticProgress || JSON.stringify(beforeRelevant) !== JSON.stringify(afterRelevant);
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
        if (operation === 'type' || operation === 'select' || operation === 'set_value' || operation === 'select_date' || operation === 'keyboard_text') return { family: operation, value: action.input.value ?? null };
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
            details: { sideEffectState: 'known', repeatedAction: actionPayload, actionFamily: noProgressFamily, target: targetSpec, before: beforeRelevant, after: afterRelevant, repeatedNoProgress, preventedCount: this.#noProgressPrevented }
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
    } finally {
      diagnostics.stop();
      download?.stop();
    }
  }

  async #browserConnection(signal?: AbortSignal): Promise<CdpConnection> {
    if (this.#browserSession && !this.#browserSession.closed) return this.#browserSession;
    const response = await fetch(new URL('/json/version', this.#endpoint), { redirect: 'error', signal: combinedSignal(signal, 3_000) });
    if (!response.ok) throw new OperatorError('CDP_HTTP_ERROR', `CDP returned HTTP ${response.status} while discovering browser endpoint.`, { retryable: true });
    const version = await response.json() as Record<string, unknown>;
    const ws = typeof version.webSocketDebuggerUrl === 'string' ? version.webSocketDebuggerUrl : '';
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
    const raw = await response.json() as Array<Record<string, unknown>>;
    return raw.slice(0, MAX_TABS).map((tab) => ({
      id: String(tab.id ?? ''),
      type: typeof tab.type === 'string' ? tab.type : undefined,
      title: typeof tab.title === 'string' ? tab.title : undefined,
      url: typeof tab.url === 'string' ? tab.url : undefined,
      webSocketDebuggerUrl: typeof tab.webSocketDebuggerUrl === 'string' ? tab.webSocketDebuggerUrl : undefined
    })).filter((tab) => tab.id.length > 0);
  }

  async #createTarget(url: string, signal?: AbortSignal): Promise<CdpTarget> {
    const endpoint = new URL('/json/new', this.#endpoint);
    endpoint.search = url;
    const response = await fetch(endpoint, { method: 'PUT', redirect: 'error', signal: combinedSignal(signal, 4_000) });
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
