import { OperatorError } from '../core/errors.ts';

const DEFAULT_TIMEOUT_MS = 8_000;

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
};

type EventListener = (params: JsonMap) => void;

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
    this.targetId = targetId;
    this.url = url;
    this.#socket = new WebSocket(url);
    this.#ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new OperatorError('CDP_CONNECT_TIMEOUT', 'Timed out connecting to browser target.', { retryable: true })), 4_000);
      this.#socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      this.#socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new OperatorError('CDP_CONNECT_FAILED', 'Failed to connect to browser target.', { retryable: true }));
      }, { once: true });
    });

    this.#socket.addEventListener('message', (event) => {
      try {
        const raw = typeof event.data === 'string' ? event.data : String(event.data);
        const message = JSON.parse(raw) as { id?: number; result?: JsonMap; error?: { message?: string; code?: number }; method?: string; params?: JsonMap };
        if (typeof message.id === 'number') {
          const pending = this.#pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.#pending.delete(message.id);
          if (message.error) {
            pending.reject(new OperatorError('CDP_COMMAND_FAILED', message.error.message ?? 'CDP command failed.', { retryable: false, details: { code: message.error.code } }));
          } else {
            pending.resolve(message.result ?? {});
          }
          return;
        }
        if (message.method) {
          for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params ?? {});
        }
      } catch {
        // Ignore malformed browser event payloads. A later command/postcondition will expose the failure.
      }
    });

    this.#socket.addEventListener('close', () => {
      this.#closed = true;
      const error = new OperatorError('CDP_CONNECTION_CLOSED', 'Browser target connection closed.', { retryable: true });
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
    });
  }

  get closed(): boolean { return this.#closed; }

  async send(method: string, params: JsonMap = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<JsonMap> {
    await this.#ready;
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      throw new OperatorError('CDP_CONNECTION_CLOSED', 'Browser target connection is not open.', { retryable: true });
    }
    const id = this.#nextId++;
    return await new Promise<JsonMap>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new OperatorError('CDP_COMMAND_TIMEOUT', `${method} timed out.`, { retryable: true }));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params }));
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
