import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  BrowserCdpProvider,
  normalizeBrowserDialogAction,
  normalizeJavaScriptDialogObservation
} from '../src/capabilities/browser-cdp.ts';

type Listener = (event: any) => void;

class DialogSocket {
  static readonly OPEN = 1;
  static mode: 'success' | 'stall' = 'success';
  static handleCalls: Array<Record<string, unknown>> = [];
  static onHandle: (() => void) | undefined;
  readonly url: string;
  readyState = 0;
  #listeners = new Map<string, Set<Listener>>();
  #dialogAnnounced = false;

  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => {
      this.readyState = DialogSocket.OPEN;
      this.#emit('open', {});
    });
  }

  addEventListener(type: string, listener: Listener, options?: { once?: boolean }): void {
    const wrapped = options?.once
      ? (event: any) => { this.removeEventListener(type, wrapped); listener(event); }
      : listener;
    const bucket = this.#listeners.get(type) ?? new Set<Listener>();
    bucket.add(wrapped);
    this.#listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as { id: number; method: string; params?: Record<string, unknown> };
    if (message.method === 'Page.enable' && !this.#dialogAnnounced) {
      this.#dialogAnnounced = true;
      queueMicrotask(() => {
        this.#event('Page.javascriptDialogOpening', {
          url: 'https://example.test/account?token=secret',
          frameId: 'frame-main',
          message: 'Secret confirmation 4111 1111 1111 1111',
          type: 'prompt',
          hasBrowserHandler: true,
          defaultPrompt: 'private default'
        });
        this.#reply(message.id, {});
      });
      return;
    }
    if (message.method === 'Page.handleJavaScriptDialog') {
      DialogSocket.handleCalls.push(message.params ?? {});
      DialogSocket.onHandle?.();
      if (DialogSocket.mode === 'stall') return;
      queueMicrotask(() => {
        this.#reply(message.id, {});
        this.#event('Page.javascriptDialogClosed', {
          result: message.params?.accept === true,
          userInput: String(message.params?.promptText ?? '')
        });
      });
      return;
    }
    this.#reply(message.id, {});
  }

  close(): void {
    this.readyState = 3;
    this.#emit('close', {});
  }

  #reply(id: number, result: Record<string, unknown>): void {
    this.#emit('message', { data: JSON.stringify({ id, result }) });
  }

  #event(method: string, params: Record<string, unknown>): void {
    this.#emit('message', { data: JSON.stringify({ method, params }) });
  }

  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

async function withDialogProvider(t: any, run: (provider: BrowserCdpProvider) => Promise<void>): Promise<void> {
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { value: DialogSocket, configurable: true, writable: true });
  DialogSocket.mode = 'success';
  DialogSocket.handleCalls = [];
  DialogSocket.onHandle = undefined;
  t.after(() => {
    DialogSocket.mode = 'success';
    DialogSocket.handleCalls = [];
    DialogSocket.onHandle = undefined;
    Object.defineProperty(globalThis, 'WebSocket', { value: original, configurable: true, writable: true });
  });
  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{
        id: 'tab-dialog', type: 'page', title: 'Dialog fixture', url: 'https://example.test/account',
        webSocketDebuggerUrl: 'ws://127.0.0.1/dialog-fixture'
      }]));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Invalid test server address.');
  const provider = new BrowserCdpProvider(`http://127.0.0.1:${address.port}`);
  t.after(() => provider.close());
  await run(provider);
}

const action = (id: string, input: Record<string, unknown>) => ({
  id,
  capability: 'browser.interact',
  risk: 'external' as const,
  input,
  provenance: { kind: 'runtime' as const }
});

test('C03 JavaScript dialog observation is target-generation bound and withholds message contents', async (t) => {
  await withDialogProvider(t, async (provider) => {
    const inspected = await provider.execute({
      id: 'dialog-inspect', capability: 'browser.inspect', risk: 'read',
      input: { targetId: 'tab-dialog' }, provenance: { kind: 'runtime' }
    });
    assert.equal(inspected.ok, true, inspected.error?.message);
    const dialog = (inspected.output as any).dialog;
    assert.match(dialog.ref, /^bd-[0-9a-f]{16}-1-[0-9a-f]{12}$/);
    assert.equal(dialog.type, 'prompt');
    assert.equal(dialog.sourceOrigin, 'https://example.test');
    assert.equal(dialog.defaultPromptPresent, true);
    assert.equal(typeof dialog.messageDigest, 'string');
    assert.equal(JSON.stringify(inspected.output).includes('4111 1111'), false);
    assert.equal(JSON.stringify(inspected.output).includes('private default'), false);
  });
});

test('C03 accepts only the exact observed dialog and proves the matching close result', async (t) => {
  await withDialogProvider(t, async (provider) => {
    const inspected = await provider.execute({
      id: 'dialog-inspect-accept', capability: 'browser.inspect', risk: 'read',
      input: { targetId: 'tab-dialog' }, provenance: { kind: 'runtime' }
    });
    const dialogRef = (inspected.output as any).dialog.ref as string;
    const accepted = await provider.execute(action('dialog-accept', {
      targetId: 'tab-dialog', operation: 'dialog_accept', dialogRef, promptText: 'approved value'
    }));
    assert.equal(accepted.ok, true, accepted.error?.message);
    assert.equal((accepted.output as any).outcome, 'accepted');
    assert.deepEqual(DialogSocket.handleCalls, [{ accept: true, promptText: 'approved value' }]);
    assert.equal(accepted.evidence.some((item) => item.kind === 'postcondition' && item.status === 'pass'), true);

    const replay = await provider.execute(action('dialog-replay', {
      targetId: 'tab-dialog', operation: 'dialog_accept', dialogRef, promptText: 'approved value'
    }));
    assert.equal(replay.ok, false);
    assert.equal(replay.error?.code, 'BROWSER_DIALOG_NOT_FOUND');
    assert.equal(replay.error?.executionPhase, 'pre_dispatch');
    assert.equal(DialogSocket.handleCalls.length, 1);
  });
});

test('C03 stale dialog refs and malformed prompts fail before CDP dispatch', async (t) => {
  await withDialogProvider(t, async (provider) => {
    const inspected = await provider.execute({
      id: 'dialog-inspect-stale', capability: 'browser.inspect', risk: 'read',
      input: { targetId: 'tab-dialog' }, provenance: { kind: 'runtime' }
    });
    const dialogRef = (inspected.output as any).dialog.ref as string;
    const staleRef = dialogRef.replace('-1-', '-2-');
    const stale = await provider.execute(action('dialog-stale', {
      targetId: 'tab-dialog', operation: 'dialog_dismiss', dialogRef: staleRef
    }));
    assert.equal(stale.ok, false);
    assert.equal(stale.error?.code, 'BROWSER_DIALOG_STALE');
    assert.equal(stale.error?.sideEffectState, 'none');
    assert.equal(stale.error?.executionPhase, 'pre_dispatch');

    const invalid = await provider.execute(action('dialog-invalid', {
      targetId: 'tab-dialog', operation: 'dialog_dismiss', dialogRef, promptText: 'not allowed'
    }));
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error?.code, 'INVALID_BROWSER_DIALOG_PROMPT');
    assert.equal(DialogSocket.handleCalls.length, 0);
  });
});

test('C03 cancellation after dialog dispatch is uncertain and never retryable', async (t) => {
  await withDialogProvider(t, async (provider) => {
    const inspected = await provider.execute({
      id: 'dialog-inspect-cancel', capability: 'browser.inspect', risk: 'read',
      input: { targetId: 'tab-dialog' }, provenance: { kind: 'runtime' }
    });
    const dialogRef = (inspected.output as any).dialog.ref as string;
    const controller = new AbortController();
    DialogSocket.mode = 'stall';
    DialogSocket.onHandle = () => controller.abort();
    const cancelled = await provider.execute(action('dialog-cancel', {
      targetId: 'tab-dialog', operation: 'dialog_dismiss', dialogRef
    }), { signal: controller.signal });
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.error?.code, 'BROWSER_DIALOG_OUTCOME_UNCERTAIN');
    assert.equal(cancelled.error?.retryable, false);
    assert.equal(cancelled.error?.sideEffectState, 'uncertain');
    assert.equal(cancelled.error?.executionPhase, 'dispatched');
    assert.equal((cancelled.error?.details as any)?.remedy, 'reobserve_dialog_do_not_retry');
  });
});

test('C03 dialog normalizers reject coercion, extra fields and malformed CDP events', () => {
  let coercions = 0;
  const poisoned = { toString() { coercions += 1; return 'dialog_accept'; } };
  for (const input of [
    null, [],
    { targetId: 'tab-dialog', operation: poisoned, dialogRef: 'bd-0000000000000000-1-000000000000' },
    { targetId: 'tab-dialog', operation: 'dialog_accept', dialogRef: 'invalid' },
    { targetId: 'tab-dialog', operation: 'dialog_accept', dialogRef: 'bd-0000000000000000-1-000000000000', extra: true }
  ]) assert.throws(() => normalizeBrowserDialogAction(input), (error: any) => error?.code === 'INVALID_BROWSER_DIALOG_ACTION');
  assert.equal(coercions, 0);
  assert.throws(() => normalizeJavaScriptDialogObservation({
    params: { type: 'prompt', message: ['forged'], hasBrowserHandler: true },
    targetId: 'tab-dialog', instanceNonce: '0'.repeat(16), generation: 1
  }), (error: any) => error?.code === 'BROWSER_DIALOG_EVENT_INVALID');
});
