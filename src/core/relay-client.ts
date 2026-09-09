import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DeviceIdentityStore } from './device-identity.ts';
import { OperatorError } from './errors.ts';

const PROTOCOL = 1;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_DELIVERY_ID = 128;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const MIN_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 20_000;

type JsonObject = Record<string, unknown>;

export interface RelaySocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void;
  removeEventListener?(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void;
}

export type RelaySocketFactory = (url: string) => RelaySocketLike;

export interface RelayDelivery {
  seq: number;
  id: string;
  kind: string;
  payload: JsonObject;
}

export interface RelayRecoveryContext {
  delivery: RelayDelivery;
  processing: {
    seq: number;
    id: string;
    startedAt: string;
  };
}

export type RelayRecoveryDecision = 'ack' | 'retry' | 'stop';

interface RelayState {
  version: 1;
  lastAckedServerSeq: number;
  processing?: {
    seq: number;
    id: string;
    startedAt: string;
  };
}

interface WelcomeFrame {
  type: 'welcome';
  protocol: 1;
  connectionId: string;
  resumeFromSeq: number;
  heartbeatMs?: number;
}

interface DeliveryFrame {
  type: 'delivery';
  seq: number;
  id: string;
  kind: string;
  payload: JsonObject;
}

interface PongFrame { type: 'pong'; nonce: string }

type ServerFrame = WelcomeFrame | DeliveryFrame | PongFrame;

export interface RelayClientOptions {
  stateDir: string;
  url: string;
  identity: DeviceIdentityStore;
  socketFactory?: RelaySocketFactory;
  getSessionToken: () => Promise<string>;
  onDelivery: (delivery: RelayDelivery) => Promise<void>;
  onRecovery?: (context: RelayRecoveryContext) => Promise<RelayRecoveryDecision>;
  allowLoopbackInsecureWs?: boolean;
  random?: () => number;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export class RelayClient {
  #stateFile: string;
  #url: string;
  #identity: DeviceIdentityStore;
  #socketFactory: RelaySocketFactory;
  #getSessionToken: () => Promise<string>;
  #onDelivery: (delivery: RelayDelivery) => Promise<void>;
  #onRecovery?: (context: RelayRecoveryContext) => Promise<RelayRecoveryDecision>;
  #random: () => number;
  #clock: () => Date;
  #sleep: (ms: number) => Promise<void>;
  #stopped = false;
  #socket: RelaySocketLike | null = null;
  #attempt = 0;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #lastPongAt = 0;

  constructor(options: RelayClientOptions) {
    this.#stateFile = path.join(path.resolve(options.stateDir), 'relay-client.json');
    this.#url = validateRelayUrl(options.url, Boolean(options.allowLoopbackInsecureWs));
    this.#identity = options.identity;
    this.#socketFactory = options.socketFactory ?? nativeSocketFactory;
    this.#getSessionToken = options.getSessionToken;
    this.#onDelivery = options.onDelivery;
    this.#onRecovery = options.onRecovery;
    this.#random = options.random ?? Math.random;
    this.#clock = options.clock ?? (() => new Date());
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async run(): Promise<void> {
    this.#stopped = false;
    while (!this.#stopped) {
      try {
        await this.#connectOnce();
        this.#attempt = 0;
      } catch (error) {
        if (this.#stopped) break;
        const delay = reconnectDelay(this.#attempt++, this.#random());
        await this.#sleep(delay);
        if (error instanceof OperatorError && !error.retryable) throw error;
      }
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#clearHeartbeat();
    try { this.#socket?.close(1000, 'operator stopping'); } catch { /* already closed */ }
    this.#socket = null;
  }

  async state(): Promise<Readonly<RelayState>> {
    return await this.#readState();
  }

  async #connectOnce(): Promise<void> {
    const state = await this.#readState();
    const token = await this.#getSessionToken();
    if (!token || Buffer.byteLength(token, 'utf8') > 16 * 1024) {
      throw new OperatorError('RELAY_SESSION_TOKEN_INVALID', 'Relay session token is missing or exceeds the bounded size.');
    }

    const socket = this.#socketFactory(this.#url);
    this.#socket = socket;
    await waitForOpen(socket);
    if (this.#stopped) return;

    const identity = await this.#identity.loadOrCreate();
    const helloPayload = {
      protocol: PROTOCOL,
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      fingerprint: identity.fingerprint,
      resumeAfterSeq: state.lastAckedServerSeq,
      pendingRecovery: state.processing ? { seq: state.processing.seq, id: state.processing.id } : null,
      sentAt: this.#clock().toISOString(),
      nonce: crypto.randomBytes(24).toString('base64url')
    };
    const signature = await this.#identity.sign(canonicalBytes(helloPayload));
    sendFrame(socket, { type: 'hello', payload: helloPayload, signature, sessionToken: token });

    await new Promise<void>((resolve, reject) => {
      let welcomed = false;
      const onError = () => reject(new OperatorError('RELAY_SOCKET_ERROR', 'Relay socket reported an error.', { retryable: true }));
      const onClose = () => resolve();
      const onMessage = (event: any) => {
        void (async () => {
          try {
            const frame = parseServerFrame(event?.data);
            if (!welcomed) {
              if (frame.type !== 'welcome') throw new OperatorError('RELAY_PROTOCOL_ERROR', 'Relay sent a non-welcome frame before handshake completion.');
              this.#validateWelcome(frame, state);
              welcomed = true;
              this.#attempt = 0;
              this.#lastPongAt = Date.now();
              this.#startHeartbeat(socket, boundedHeartbeat(frame.heartbeatMs));
              return;
            }
            if (frame.type === 'pong') {
              this.#lastPongAt = Date.now();
              return;
            }
            if (frame.type === 'welcome') throw new OperatorError('RELAY_PROTOCOL_ERROR', 'Relay sent a duplicate welcome frame.');
            await this.#handleDelivery(socket, frame);
          } catch (error) {
            this.#clearHeartbeat();
            try { socket.close(4002, 'protocol/recovery error'); } catch { /* noop */ }
            reject(error instanceof OperatorError ? error : new OperatorError('RELAY_PROTOCOL_ERROR', String(error), { retryable: true }));
          }
        })();
      };
      socket.addEventListener('message', onMessage);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
    });
    this.#clearHeartbeat();
    this.#socket = null;
  }

  #validateWelcome(frame: WelcomeFrame, state: RelayState): void {
    if (frame.protocol !== PROTOCOL) throw new OperatorError('RELAY_PROTOCOL_VERSION', 'Relay protocol version mismatch.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(frame.connectionId)) throw new OperatorError('RELAY_PROTOCOL_ERROR', 'Relay connection ID is invalid.');
    if (!Number.isSafeInteger(frame.resumeFromSeq) || frame.resumeFromSeq < 0) throw new OperatorError('RELAY_PROTOCOL_ERROR', 'Relay resume sequence is invalid.');
    if (frame.resumeFromSeq !== state.lastAckedServerSeq) {
      throw new OperatorError('RELAY_RESUME_MISMATCH', 'Relay resume cursor does not match the durable local acknowledgement cursor.', { retryable: true });
    }
  }

  async #handleDelivery(socket: RelaySocketLike, frame: DeliveryFrame): Promise<void> {
    const delivery = validateDelivery(frame);
    let state = await this.#readState();

    if (delivery.seq <= state.lastAckedServerSeq) {
      sendFrame(socket, { type: 'ack', seq: delivery.seq, id: delivery.id, duplicate: true });
      return;
    }
    if (delivery.seq !== state.lastAckedServerSeq + 1) {
      throw new OperatorError('RELAY_SEQUENCE_GAP', `Expected relay sequence ${state.lastAckedServerSeq + 1} but received ${delivery.seq}.`, { retryable: true });
    }

    if (state.processing) {
      if (state.processing.seq !== delivery.seq || state.processing.id !== delivery.id) {
        throw new OperatorError('RELAY_RECOVERY_CONFLICT', 'A different delivery arrived while an uncertain delivery is awaiting recovery.', { retryable: false });
      }
      if (!this.#onRecovery) {
        throw new OperatorError('RELAY_RECOVERY_REQUIRED', 'A prior delivery may have executed before a crash; explicit recovery is required before replay.', { retryable: false });
      }
      const decision = await this.#onRecovery({ delivery, processing: { ...state.processing } });
      if (decision === 'stop') throw new OperatorError('RELAY_RECOVERY_REQUIRED', 'Recovery callback refused to continue the uncertain delivery.', { retryable: false });
      if (decision === 'retry') {
        await this.#writeState({ ...state, processing: undefined });
        state = await this.#readState();
      } else if (decision === 'ack') {
        const completed = { version: 1 as const, lastAckedServerSeq: delivery.seq };
        await this.#writeState(completed);
        sendFrame(socket, { type: 'ack', seq: delivery.seq, id: delivery.id, recovered: true });
        return;
      } else {
        throw new OperatorError('RELAY_RECOVERY_REQUIRED', 'Recovery callback returned an invalid decision.', { retryable: false });
      }
    }

    const processing: RelayState['processing'] = { seq: delivery.seq, id: delivery.id, startedAt: this.#clock().toISOString() };
    await this.#writeState({ ...state, processing });
    await this.#onDelivery(delivery);
    await this.#writeState({ version: 1, lastAckedServerSeq: delivery.seq });
    sendFrame(socket, { type: 'ack', seq: delivery.seq, id: delivery.id });
  }

  #startHeartbeat(socket: RelaySocketLike, heartbeatMs: number): void {
    this.#clearHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      if (Date.now() - this.#lastPongAt > heartbeatMs * 3) {
        try { socket.close(4000, 'heartbeat timeout'); } catch { /* noop */ }
        return;
      }
      const nonce = crypto.randomBytes(12).toString('base64url');
      try { sendFrame(socket, { type: 'ping', nonce, at: new Date().toISOString() }); } catch { /* close path handles reconnect */ }
    }, heartbeatMs);
    this.#heartbeatTimer.unref();
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
  }

  async #readState(): Promise<RelayState> {
    try {
      const stat = await fs.stat(this.#stateFile);
      if (!stat.isFile() || stat.size > 64 * 1024) throw new OperatorError('RELAY_STATE_CORRUPT', 'Relay client state is invalid.');
      return validateState(JSON.parse(await fs.readFile(this.#stateFile, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, lastAckedServerSeq: 0 };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('RELAY_STATE_CORRUPT', 'Relay client state could not be read.');
    }
  }

  async #writeState(stateInput: RelayState): Promise<void> {
    const state = validateState(stateInput);
    await fs.mkdir(path.dirname(this.#stateFile), { recursive: true, mode: 0o700 });
    const temp = `${this.#stateFile}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temp, this.#stateFile);
  }
}

export function reconnectDelay(attemptInput: number, randomInput = Math.random()): number {
  const attempt = Math.min(Math.max(Math.trunc(attemptInput), 0), 20);
  const random = Number.isFinite(randomInput) ? Math.min(Math.max(randomInput, 0), 1) : 0.5;
  const base = Math.min(MIN_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  const jitter = 0.75 + random * 0.5;
  return Math.min(Math.max(Math.round(base * jitter), MIN_BACKOFF_MS), MAX_BACKOFF_MS);
}

export function validateRelayUrl(urlInput: string, allowLoopbackInsecureWs = false): string {
  let url: URL;
  try { url = new URL(urlInput); } catch { throw new OperatorError('RELAY_URL_INVALID', 'Relay URL is invalid.'); }
  if (url.username || url.password || url.hash) throw new OperatorError('RELAY_URL_INVALID', 'Relay URL must not contain credentials or a fragment.');
  if (url.protocol === 'wss:') return url.toString();
  if (url.protocol === 'ws:' && allowLoopbackInsecureWs && isLoopbackHost(url.hostname)) return url.toString();
  throw new OperatorError('RELAY_TLS_REQUIRED', 'Relay connections require wss://; insecure ws:// is permitted only for explicit loopback development tests.');
}

function validateState(input: any): RelayState {
  if (!input || input.version !== 1 || !Number.isSafeInteger(input.lastAckedServerSeq) || input.lastAckedServerSeq < 0 || input.lastAckedServerSeq > MAX_SEQUENCE) {
    throw new OperatorError('RELAY_STATE_CORRUPT', 'Relay client state structure is invalid.');
  }
  if (input.processing === undefined) return { version: 1, lastAckedServerSeq: input.lastAckedServerSeq };
  const seq = Number(input.processing.seq);
  const id = validDeliveryId(String(input.processing.id ?? ''));
  const startedAt = validIso(String(input.processing.startedAt ?? ''));
  if (!Number.isSafeInteger(seq) || seq !== input.lastAckedServerSeq + 1) throw new OperatorError('RELAY_STATE_CORRUPT', 'Relay processing sequence is invalid.');
  return { version: 1, lastAckedServerSeq: input.lastAckedServerSeq, processing: { seq, id, startedAt } };
}

function validateDelivery(frame: DeliveryFrame): RelayDelivery {
  if (!Number.isSafeInteger(frame.seq) || frame.seq < 1 || frame.seq > MAX_SEQUENCE) throw new OperatorError('RELAY_PROTOCOL_ERROR', 'Relay delivery sequence is invalid.');
  const id = validDeliveryId(frame.id);
  const kind = String(frame.kind ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(kind)) throw new OperatorError('RELAY_PROTOCOL_ERROR', 'Relay delivery kind is invalid.');
  if (!frame.payload || typeof frame.payload !== 'object' || Array.isArray(frame.payload)) throw new OperatorError('RELAY_PROTOCOL_ERROR', 'Relay delivery payload must be an object.');
  return { seq: frame.seq, id, kind, payload: frame.payload };
}

function validDeliveryId(value: string): string {
  if (!value || value.length > MAX_DELIVERY_ID || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) throw new OperatorError('RELAY_PROTOCOL_ERROR', 'Relay delivery ID is invalid.');
  return value;
}

function parseServerFrame(raw: unknown): ServerFrame {
  const text = typeof raw === 'string' ? raw : raw instanceof ArrayBuffer ? Buffer.from(raw).toString('utf8') : ArrayBuffer.isView(raw) ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8') : '';
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) throw new OperatorError('RELAY_FRAME_INVALID', 'Relay frame is missing or exceeds the bounded size.');
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { throw new OperatorError('RELAY_FRAME_INVALID', 'Relay frame is not valid JSON.'); }
  if (!parsed || typeof parsed !== 'object') throw new OperatorError('RELAY_FRAME_INVALID', 'Relay frame must be an object.');
  if (parsed.type === 'welcome') return parsed as WelcomeFrame;
  if (parsed.type === 'delivery') return parsed as DeliveryFrame;
  if (parsed.type === 'pong' && typeof parsed.nonce === 'string') return parsed as PongFrame;
  throw new OperatorError('RELAY_PROTOCOL_ERROR', 'Relay frame type is unsupported.');
}

function sendFrame(socket: RelaySocketLike, frame: JsonObject): void {
  const text = JSON.stringify(frame);
  if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) throw new OperatorError('RELAY_FRAME_TOO_LARGE', 'Outbound relay frame exceeds the bounded size.');
  socket.send(text);
}

function boundedHeartbeat(value: unknown): number {
  const parsed = Number(value ?? DEFAULT_HEARTBEAT_MS);
  if (!Number.isInteger(parsed)) return DEFAULT_HEARTBEAT_MS;
  return Math.min(Math.max(parsed, 5_000), 60_000);
}

function waitForOpen(socket: RelaySocketLike): Promise<void> {
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onOpen = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new OperatorError('RELAY_CONNECT_FAILED', 'Relay socket failed before opening.', { retryable: true })); };
    const onClose = () => { cleanup(); reject(new OperatorError('RELAY_CONNECT_FAILED', 'Relay socket closed before opening.', { retryable: true })); };
    const cleanup = () => {
      socket.removeEventListener?.('open', onOpen);
      socket.removeEventListener?.('error', onError);
      socket.removeEventListener?.('close', onClose);
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
  });
}

function canonicalBytes(value: JsonObject): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function nativeSocketFactory(url: string): RelaySocketLike {
  const Ctor = (globalThis as any).WebSocket;
  if (typeof Ctor !== 'function') throw new OperatorError('RELAY_WEBSOCKET_UNAVAILABLE', 'This Node runtime does not provide a WebSocket client.', { retryable: false });
  return new Ctor(url) as RelaySocketLike;
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '127.0.0.1' || value === '::1';
}
