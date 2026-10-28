import { OperatorError } from '../core/errors.ts';

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_CDP_MESSAGE_BYTES = 4 * 1024 * 1024;

export type JsonMap = Record<string, unknown>;

export type CdpTarget = {
  id: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

type Pending = {
  resolve: (value: JsonMap) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  detachAbort?: () => void;
};

type EventListener = (params: JsonMap, sessionId?: string) => void;

function isJsonObject(value: unknown): value is JsonMap {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCdpError(value: unknown): value is { message: string; code?: number } {
  return isJsonObject(value) && typeof value.message === 'string' && value.message.length > 0
    && (value.code === undefined || (typeof value.code === 'number' && Number.isSafeInteger(value.code)));
}

export function assertLoopbackDebuggerUrl(raw: string): void {
  let url: URL;
  try { url = new URL(raw); } catch { throw new OperatorError('UNSAFE_CDP_WEBSOCKET', 'Invalid DevTools WebSocket URL.'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
    throw new OperatorError('UNSAFE_CDP_WEBSOCKET', 'DevTools WebSocket endpoint must be loopback-only.');
  }
  if (url.username || url.password || url.hash) {
    throw new OperatorError('UNSAFE_CDP_WEBSOCKET', 'DevTools WebSocket endpoint must not contain credentials or a fragment.');
  }
}

function sameWebSocketDestination(expectedRaw: string, actualRaw: string): boolean {
  try { return new URL(expectedRaw).toString() === new URL(actualRaw).toString(); } catch { return false; }
}

export class CdpConnection {
  readonly targetId: string;
  readonly url: string;
  #socket: WebSocket;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #listeners = new Map<string, Set<EventListener>>();
  #ready: Promise<void>;
  #closed = false;

  constructor(targetId: string, url: string) {
    assertLoopbackDebuggerUrl(url);
    this.targetId = targetId;
    this.url = url;
    this.#socket = new WebSocket(url);
    this.#ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };
      const timeout = setTimeout(() => finish(() => {
        this.#closed = true;
        try { this.#socket.close(); } catch { /* timeout is already authoritative */ }
        reject(new OperatorError('CDP_CONNECT_TIMEOUT', 'Timed out connecting to browser target.', { retryable: true }));
      }), 4_000);
      this.#socket.addEventListener('open', () => finish(() => {
        if (!sameWebSocketDestination(url, this.#socket.url)) {
          this.#closed = true;
          try { this.#socket.close(); } catch { /* destination mismatch is already authoritative */ }
          reject(new OperatorError('CDP_WEBSOCKET_DESTINATION_CHANGED', 'Opened DevTools WebSocket destination differs from the authorized endpoint.', { retryable: false }));
          return;
        }
        resolve();
      }), { once: true });
      this.#socket.addEventListener('error', () => finish(() => {
        this.#closed = true;
        try { this.#socket.close(); } catch { /* connection error is already authoritative */ }
        reject(new OperatorError('CDP_CONNECT_FAILED', 'Failed to connect to browser target.', { retryable: true }));
      }), { once: true });
      // A WebSocket may close without emitting an error or ever opening.
      // Settle the handshake immediately rather than waiting for the entire
      // connection timeout before the caller can recover/reconnect.
      this.#socket.addEventListener('close', () => finish(() => {
        this.#closed = true;
        reject(new OperatorError('CDP_CONNECTION_CLOSED', 'Browser target connection closed during setup.', { retryable: true }));
      }), { once: true });
    });

    this.#socket.addEventListener('message', (event) => {
      try {
        const raw = typeof event.data === 'string' ? event.data : String(event.data);
        if (Buffer.byteLength(raw, 'utf8') > MAX_CDP_MESSAGE_BYTES) {
          this.close();
          return;
        }
        const message = JSON.parse(raw) as {
          id?: number;
          result?: JsonMap;
          error?: { message?: string; code?: number };
          method?: string;
          params?: JsonMap;
          sessionId?: string;
        };
        if (typeof message.id === 'number') {
          const pending = this.#pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          pending.detachAbort?.();
          this.#pending.delete(message.id);
          const hasError = Object.hasOwn(message, 'error');
          const hasResult = Object.hasOwn(message, 'result');
          if (hasError === hasResult || (hasResult && !isJsonObject(message.result)) || (hasError && !isCdpError(message.error))) {
            // A reply without a valid outcome cannot prove the action succeeded.
            // The command was already dispatched; its side effect is uncertain.
            pending.reject(new OperatorError('CDP_RESPONSE_INVALID', 'Browser target returned a malformed command outcome.', {
              retryable: false,
              details: { executionPhase: 'dispatched', sideEffectState: 'uncertain', remedy: 'reobserve_before_retry' }
            }));
          } else if (hasError) {
            pending.reject(new OperatorError('CDP_COMMAND_FAILED', message.error!.message, { retryable: false, details: { code: message.error!.code } }));
          } else {
            pending.resolve(message.result!);
          }
          return;
        }
        if (message.method) {
          for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params ?? {}, message.sessionId);
        }
      } catch {
        // Ignore malformed browser event payloads. A later command/postcondition will expose the failure.
      }
    });

    this.#socket.addEventListener('close', () => {
      this.#closed = true;
      const error = dispatchedFailure('CDP_CONNECTION_CLOSED', 'Browser target connection closed while a command was in flight.');
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.detachAbort?.();
        pending.reject(error);
      }
      this.#pending.clear();
    });
  }

  get closed(): boolean { return this.#closed; }

  async send(method: string, params: JsonMap = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<JsonMap> {
    return this.#send(method, params, timeoutMs, undefined, signal);
  }

  async sendInSession(sessionId: string, method: string, params: JsonMap = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<JsonMap> {
    if (typeof sessionId !== 'string' || !sessionId.length || sessionId.length > 256) {
      throw new OperatorError('INVALID_CDP_SESSION', 'Flattened CDP session id must be a string of 1-256 characters.');
    }
    return this.#send(method, params, timeoutMs, sessionId, signal);
  }

  async #send(method: string, params: JsonMap, timeoutMs: number, sessionId?: string, signal?: AbortSignal): Promise<JsonMap> {
    if (signal?.aborted) throw aborted();
    await waitForReadyOrAbort(this.#ready, signal);
    if (signal?.aborted) throw aborted();
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      throw new OperatorError('CDP_CONNECTION_CLOSED', 'Browser target connection is not open.', { retryable: true });
    }
    const id = this.#nextId++;
    return await new Promise<JsonMap>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        reject(dispatchedFailure('CDP_COMMAND_TIMEOUT', `${method} timed out after dispatch.`));
      }, timeoutMs);
      const onAbort = () => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        reject(dispatchedFailure('EXECUTION_ABORTED', 'Browser execution was cancelled after command dispatch.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, { resolve, reject, timer, ...(signal ? { detachAbort: () => signal.removeEventListener('abort', onAbort) } : {}) });
      try {
        this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch {
        // Synchronous send failures never create an acknowledged CDP request.
        // Do not retain a phantom pending command or an abort listener until
        // timeout; allow the caller to surface the transport failure promptly.
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.#pending.delete(id);
        reject(new OperatorError('CDP_COMMAND_SEND_FAILED', 'Unable to queue browser target command.', { retryable: true }));
      }
    });
  }

  on(method: string, listener: EventListener): () => void {
    const bucket = this.#listeners.get(method) ?? new Set<EventListener>();
    bucket.add(listener);
    this.#listeners.set(method, bucket);
    return () => {
      bucket.delete(listener);
      if (bucket.size === 0) this.#listeners.delete(method);
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#socket.close(); } catch { /* noop */ }
  }
}

async function waitForReadyOrAbort(ready: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) { await ready; return; }
  if (signal.aborted) throw aborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(aborted());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    ready.then(
      () => { signal.removeEventListener('abort', onAbort); resolve(); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); }
    );
    if (signal.aborted) onAbort();
  });
}

function aborted(): OperatorError {
  return new OperatorError('EXECUTION_ABORTED', 'Browser execution was cancelled.', { retryable: false });
}

function dispatchedFailure(code: string, message: string): OperatorError {
  return new OperatorError(code, message, {
    retryable: false,
    details: { executionPhase: 'dispatched', sideEffectState: 'uncertain', remedy: 'reobserve_before_retry' }
  });
}

export class CdpSessionManager {
  #sessions = new Map<string, CdpConnection>();

  get(target: CdpTarget): CdpConnection {
    if (!target.webSocketDebuggerUrl) {
      throw new OperatorError('CDP_TARGET_UNAVAILABLE', 'Target does not expose a DevTools WebSocket endpoint.', { retryable: true });
    }
    const existing = this.#sessions.get(target.id);
    if (existing && !existing.closed && existing.url === target.webSocketDebuggerUrl) return existing;
    existing?.close();
    const created = new CdpConnection(target.id, target.webSocketDebuggerUrl);
    this.#sessions.set(target.id, created);
    return created;
  }

  forget(targetId: string): void {
    this.#sessions.get(targetId)?.close();
    this.#sessions.delete(targetId);
  }

  closeAll(): void {
    for (const session of this.#sessions.values()) session.close();
    this.#sessions.clear();
  }
}
