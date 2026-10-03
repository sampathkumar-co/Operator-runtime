import crypto from 'node:crypto';
import path from 'node:path';
import { DeviceIdentityStore } from './device-identity.ts';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

const PROTOCOL = 1;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_DELIVERY_ID = 128;
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const MIN_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 20_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const MIN_CONNECT_TIMEOUT_MS = 100;
const MAX_CONNECT_TIMEOUT_MS = 60_000;
const DEFAULT_CONCURRENT_READS = 4;
const MAX_CONCURRENT_READS = 16;

type JsonObject = Record<string, unknown>;

export interface RelaySocketLike {
  readonly readyState: number;
  readonly url?: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void;
  removeEventListener?(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void;
}

export type RelaySocketFactory = (url: string) => RelaySocketLike;

export interface RelayResourceProfile {
  cpuSlots: number;
  memoryMb: number;
  gpu: boolean;
  tags: string[];
  maxConcurrentJobs: number;
}

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

export interface RelayExpiredRecoveryContext {
  processing: RelayRecoveryContext['processing'];
  expiredThroughSeq: number;
}

export type RelayExpiredRecoveryDecision = 'ack' | 'stop';

export type RelayClientStatus =
  | { state: 'socket-connected' }
  | { state: 'authenticated-ready'; capabilityCount: number }
  | { state: 'reconnect-wait'; code: string; delayMs: number };

export type RelayConnectionState =
  | { state: 'STARTING' }
  | { state: 'CONNECTING'; attempt: number }
  | { state: 'AUTHENTICATING' }
  | { state: 'READY'; capabilityCount: number }
  | { state: 'DEGRADED'; code: string; recoverable: boolean }
  | { state: 'RECONNECTING'; code: string; delayMs: number; attempt: number }
  | { state: 'REVOKED'; code: string }
  | { state: 'SHUTTING_DOWN' };

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
  logicalSessionId?: string;
  resumeFromSeq: number;
  expiredThroughSeq?: number;
  heartbeatMs?: number;
  capabilityBinding?: 1;
  capabilities?: string[];
  readConcurrency?: number;
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
  logicalSessionId?: string;
  getSessionToken: () => Promise<string>;
  supportedCapabilities?: readonly string[];
  getSupportedCapabilities?: () => Promise<readonly string[]>;
  resourceProfile?: RelayResourceProfile;
  getResourceProfile?: () => Promise<RelayResourceProfile>;
  onDelivery: (delivery: RelayDelivery) => Promise<void>;
  onRecovery?: (context: RelayRecoveryContext) => Promise<RelayRecoveryDecision>;
  onExpiredRecovery?: (context: RelayExpiredRecoveryContext) => Promise<RelayExpiredRecoveryDecision>;
  onAcknowledged?: (delivery: Pick<RelayDelivery, 'seq' | 'id'>) => Promise<void> | void;
  onStatus?: (status: RelayClientStatus) => void;
  onConnectionState?: (status: RelayConnectionState) => void;
  allowLoopbackInsecureWs?: boolean;
  random?: () => number;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  connectTimeoutMs?: number;
  maxConcurrentReadDeliveries?: number;
}

export class RelayClient {
  #stateFile: string;
  #url: string;
  #identity: DeviceIdentityStore;
  #socketFactory: RelaySocketFactory;
  #logicalSessionId: string;
  #getSessionToken: () => Promise<string>;
  #getSupportedCapabilities: () => Promise<string[]>;
  #requireCapabilityBinding: boolean;
  #getResourceProfile?: () => Promise<RelayResourceProfile>;
  #onDelivery: (delivery: RelayDelivery) => Promise<void>;
  #onRecovery?: (context: RelayRecoveryContext) => Promise<RelayRecoveryDecision>;
  #onExpiredRecovery?: (context: RelayExpiredRecoveryContext) => Promise<RelayExpiredRecoveryDecision>;
  #onAcknowledged?: (delivery: Pick<RelayDelivery, 'seq' | 'id'>) => Promise<void> | void;
  #onStatus?: (status: RelayClientStatus) => void;
  #onConnectionState?: (status: RelayConnectionState) => void;
  #random: () => number;
  #clock: () => Date;
  #sleep: (ms: number) => Promise<void>;
  #connectTimeoutMs: number;
  #maxConcurrentReadDeliveries: number;
  #stopped = false;
  #socket: RelaySocketLike | null = null;
  #attempt = 0;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #lastPongAt = 0;
  #interruptConnection: ((mode?: 'reconnect' | 'shutdown') => void) | null = null;

  constructor(options: RelayClientOptions) {
    this.#stateFile = path.join(path.resolve(options.stateDir), 'relay-client.json');
    this.#url = validateRelayUrl(options.url, Boolean(options.allowLoopbackInsecureWs));
    this.#identity = options.identity;
    this.#socketFactory = options.socketFactory ?? nativeSocketFactory;
    this.#logicalSessionId = options.logicalSessionId === undefined ? crypto.randomUUID() : validLogicalSessionId(options.logicalSessionId);
    this.#getSessionToken = options.getSessionToken;
    if (options.supportedCapabilities !== undefined && options.getSupportedCapabilities) {
      throw new OperatorError('RELAY_CAPABILITIES_CONFIGURATION_INVALID', 'Configure either static or dynamic relay capabilities, not both.');
    }
    this.#requireCapabilityBinding = options.supportedCapabilities !== undefined || options.getSupportedCapabilities !== undefined;
    const staticCapabilities = validateSupportedCapabilities(options.supportedCapabilities ?? []);
    this.#getSupportedCapabilities = options.getSupportedCapabilities
      ? async () => validateSupportedCapabilities(await options.getSupportedCapabilities!())
      : async () => [...staticCapabilities];
    if (options.resourceProfile !== undefined && options.getResourceProfile) {
      throw new OperatorError('RELAY_RESOURCE_PROFILE_CONFIGURATION_INVALID', 'Configure either static or dynamic relay resource profile, not both.');
    }
    const staticResourceProfile = options.resourceProfile === undefined ? undefined : validateResourceProfile(options.resourceProfile);
    this.#getResourceProfile = options.getResourceProfile
      ? async () => validateResourceProfile(await options.getResourceProfile!())
      : staticResourceProfile
        ? async () => ({ ...staticResourceProfile, tags: [...staticResourceProfile.tags] })
        : undefined;
    this.#onDelivery = options.onDelivery;
    this.#onRecovery = options.onRecovery;
    this.#onExpiredRecovery = options.onExpiredRecovery;
    this.#onAcknowledged = options.onAcknowledged;
    this.#onStatus = options.onStatus;
    this.#onConnectionState = options.onConnectionState;
    this.#random = options.random ?? Math.random;
    this.#clock = options.clock ?? (() => new Date());
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#connectTimeoutMs = boundedConnectTimeout(options.connectTimeoutMs);
    this.#maxConcurrentReadDeliveries = boundedReadConcurrency(options.maxConcurrentReadDeliveries ?? DEFAULT_CONCURRENT_READS);
  }

  async run(): Promise<void> {
    this.#stopped = false;
    this.#emitConnectionState({ state: 'STARTING' });
    while (!this.#stopped) {
      this.#emitConnectionState({ state: 'CONNECTING', attempt: this.#attempt + 1 });
      try {
        await this.#connectOnce();
        this.#attempt = 0;
      } catch (error) {
        if (this.#stopped) break;
        const code = error instanceof OperatorError ? error.code : 'RELAY_CONNECTION_FAILED';
        if (error instanceof OperatorError && !error.retryable) {
          if (isRevocationCode(code)) this.#emitConnectionState({ state: 'REVOKED', code });
          else this.#emitConnectionState({ state: 'DEGRADED', code, recoverable: false });
          throw error;
        }
        const requestedReconnect = code === 'RELAY_RECONNECT_REQUESTED';
        const delay = requestedReconnect ? 0 : reconnectDelay(this.#attempt++, this.#random());
        this.#emitStatus({ state: 'reconnect-wait', code, delayMs: delay });
        this.#emitConnectionState({ state: 'RECONNECTING', code, delayMs: delay, attempt: this.#attempt + 1 });
        await this.#sleep(delay);
      }
    }
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#emitConnectionState({ state: 'SHUTTING_DOWN' });
    this.#clearHeartbeat();
    const interrupt = this.#interruptConnection;
    if (interrupt) {
      interrupt('shutdown');
      return;
    }
    try { this.#socket?.close(1000, 'operator stopping'); } catch { /* already closed */ }
    this.#socket = null;
  }

  reconnect(): void {
    if (this.#stopped) return;
    const interrupt = this.#interruptConnection;
    if (interrupt) {
      interrupt('reconnect');
      return;
    }
    try { this.#socket?.close(1012, 'session refresh recovery'); } catch { /* reconnect loop handles the next attempt */ }
  }

  async state(): Promise<Readonly<RelayState>> {
    return await this.#readState();
  }

  async #connectOnce(): Promise<void> {
    const state = await this.#readState();
    const token = await this.#getSessionToken();
    const supportedCapabilities = await this.#getSupportedCapabilities();
    const resourceProfile = this.#getResourceProfile ? await this.#getResourceProfile() : undefined;
    if (!token || Buffer.byteLength(token, 'utf8') > 16 * 1024) {
      throw new OperatorError('RELAY_SESSION_TOKEN_INVALID', 'Relay session token is missing or exceeds the bounded size.');
    }

    const socket = this.#socketFactory(this.#url);
    this.#socket = socket;
    await waitForOpen(socket, this.#connectTimeoutMs);
    if (typeof socket.url === 'string' && !sameRelayDestination(this.#url, socket.url)) {
      try { socket.close(4003, 'destination changed'); } catch { /* mismatch is already authoritative */ }
      throw new OperatorError('RELAY_SOCKET_DESTINATION_CHANGED', 'Opened relay WebSocket destination differs from the authorized endpoint.', { retryable: false });
    }
    if (this.#stopped) return;
    this.#emitConnectionState({ state: 'AUTHENTICATING' });
    this.#emitStatus({ state: 'socket-connected' });

    const identity = await this.#identity.loadOrCreate();
    const helloPayload = {
      protocol: PROTOCOL,
      logicalSessionId: this.#logicalSessionId,
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      fingerprint: identity.fingerprint,
      resumeAfterSeq: state.lastAckedServerSeq,
      pendingRecovery: state.processing ? { seq: state.processing.seq, id: state.processing.id } : null,
      ...(this.#requireCapabilityBinding ? { capabilityBinding: 1 as const, capabilities: [...supportedCapabilities] } : {}),
      ...(resourceProfile ? { resourceProfile } : {}),
      readConcurrency: this.#maxConcurrentReadDeliveries,
      sentAt: this.#clock().toISOString(),
      nonce: crypto.randomBytes(24).toString('base64url')
    };
    const signature = await this.#identity.sign(canonicalBytes(helloPayload));

    const connectionDone = new Promise<void>((resolve, reject) => {
      let welcomed = false;
      let settled = false;
      let messageQueue: Promise<void> = Promise.resolve();
      let interrupt: ((mode?: 'reconnect' | 'shutdown') => void) | null = null;
      let reconnectRequested = false;
      let drainRequested = false;
      let connectionDrain: Promise<void> | null = null;
      let readConcurrency = 1;
      let nextReceiveSeq = state.lastAckedServerSeq + 1;
      let nextAckSeq = state.lastAckedServerSeq + 1;
      const activeReads = new Set<number>();
      const activeReadTasks = new Map<number, Promise<void>>();
      const completedReads = new Map<number, RelayDelivery>();
      let readAckQueue: Promise<void> = Promise.resolve();

      const cleanup = () => {
        socket.removeEventListener?.('message', onMessage);
        socket.removeEventListener?.('error', onError);
        socket.removeEventListener?.('close', onClose);
        if (this.#interruptConnection === interrupt) this.#interruptConnection = null;
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        this.#clearHeartbeat();
        cleanup();
        try { socket.close(4002, 'protocol/recovery error'); } catch { /* noop */ }
        reject(error instanceof OperatorError ? error : new OperatorError('RELAY_PROTOCOL_ERROR', error instanceof Error ? error.message : String(error), { retryable: true }));
      };
      const drainConnection = (error: OperatorError | null, explicitReconnect = false) => {
        if (settled || drainRequested) return;
        drainRequested = true;
        if (explicitReconnect) reconnectRequested = true;
        socket.removeEventListener?.('message', onMessage);
        this.#clearHeartbeat();
        connectionDrain = (async () => {
          // Once the transport is ending, stop accepting fresh work but let
          // every already-accepted delivery reach its durable result/cursor
          // boundary before a replacement connection or process exit.
          try { await messageQueue; }
          catch { /* the initiating connection/protocol error remains authoritative; accepted parallel work still drains */ }
          while (activeReadTasks.size > 0) {
            await Promise.all([...activeReadTasks.values()]);
          }
          await readAckQueue;
          if (error) {
            fail(error);
            return;
          }
          try { socket.close(1000, 'operator stopping'); } catch { /* already closed */ }
          succeed();
        })();
        void connectionDrain.catch(fail);
      };
      const onError = () => {
        drainConnection(new OperatorError('RELAY_SOCKET_ERROR', 'Relay socket reported an error.', { retryable: true }));
      };
      const onClose = () => {
        if (this.#stopped) drainConnection(null);
        else drainConnection(new OperatorError(welcomed ? 'RELAY_SOCKET_CLOSED' : 'RELAY_CONNECT_FAILED', welcomed ? 'Relay socket closed unexpectedly.' : 'Relay socket closed before handshake completion.', { retryable: true }));
      };
      const processMessage = async (frame: ServerFrame) => {
        if (!welcomed) {
          if (frame.type !== 'welcome') throw new OperatorError('RELAY_PROTOCOL_ERROR', 'Relay sent a non-welcome frame before handshake completion.');
          const negotiated = await this.#validateWelcome(frame, state, supportedCapabilities);
          if (this.#stopped) return;
          readConcurrency = negotiated.readConcurrency;
          nextReceiveSeq = frame.resumeFromSeq + 1;
          nextAckSeq = frame.resumeFromSeq + 1;
          welcomed = true;
          this.#attempt = 0;
          this.#lastPongAt = this.#clock().getTime();
          this.#startHeartbeat(socket, boundedHeartbeat(frame.heartbeatMs));
          this.#emitStatus({ state: 'authenticated-ready', capabilityCount: negotiated.capabilities.length });
          this.#emitConnectionState({ state: 'READY', capabilityCount: negotiated.capabilities.length });
          return;
        }
        if (frame.type === 'pong') {
          this.#lastPongAt = this.#clock().getTime();
          return;
        }
        if (frame.type === 'welcome') throw new OperatorError('RELAY_PROTOCOL_ERROR', 'Relay sent a duplicate welcome frame.');
        const delivery = validateDelivery(frame);
        if (readConcurrency > 1 && isConcurrentReadDelivery(delivery)) {
          const durable = await this.#readState();
          if (delivery.seq <= durable.lastAckedServerSeq) {
            await this.#notifyAcknowledged(delivery);
            sendAckFrame(socket, { type: 'ack', seq: delivery.seq, id: delivery.id, duplicate: true });
            return;
          }
          if (delivery.seq !== nextReceiveSeq) {
            throw new OperatorError('RELAY_SEQUENCE_GAP', `Expected relay sequence ${nextReceiveSeq} but received ${delivery.seq}.`, { retryable: true });
          }
          if (activeReads.size >= readConcurrency) {
            throw new OperatorError('RELAY_READ_WINDOW_EXCEEDED', 'Relay exceeded the negotiated concurrent read window.', { retryable: true });
          }
          nextReceiveSeq += 1;
          activeReads.add(delivery.seq);
          const readTask = this.#onDelivery(delivery).then(() => {
            completedReads.set(delivery.seq, delivery);
            readAckQueue = readAckQueue.then(async () => {
              while (completedReads.has(nextAckSeq)) {
                const completed = completedReads.get(nextAckSeq)!;
                const current = await this.#readState();
                if (current.processing) {
                  throw new OperatorError('RELAY_RECOVERY_CONFLICT', 'Concurrent read ACK cannot advance while a durable non-read delivery is processing.', { retryable: false });
                }
                if (current.lastAckedServerSeq !== completed.seq - 1) {
                  throw new OperatorError('RELAY_SEQUENCE_GAP', 'Concurrent read ACK cursor is not contiguous.', { retryable: true });
                }
                await this.#writeState({ version: 1, lastAckedServerSeq: completed.seq });
                await this.#notifyAcknowledged(completed);
                sendAckFrame(socket, { type: 'ack', seq: completed.seq, id: completed.id });
                completedReads.delete(completed.seq);
                activeReads.delete(completed.seq);
                nextAckSeq = completed.seq + 1;
              }
            });
            return readAckQueue;
          });
          activeReadTasks.set(delivery.seq, readTask);
          void readTask.finally(() => activeReadTasks.delete(delivery.seq)).catch(fail);
          return;
        }
        if (activeReads.size > 0) {
          await Promise.all([...activeReadTasks.values()]);
          if (activeReads.size > 0) {
            throw new OperatorError('RELAY_READ_BARRIER_STALLED', 'Concurrent reads did not drain before a serialization-barrier delivery.', { retryable: true });
          }
        }
        await this.#handleDelivery(socket, frame);
        const durable = await this.#readState();
        nextReceiveSeq = durable.lastAckedServerSeq + 1;
        nextAckSeq = durable.lastAckedServerSeq + 1;
      };
      const onMessage = (event: any) => {
        let frame: ServerFrame;
        try { frame = parseServerFrame(event?.data); }
        catch (error) {
          drainConnection(error instanceof OperatorError
            ? error
            : new OperatorError('RELAY_PROTOCOL_ERROR', error instanceof Error ? error.message : String(error), { retryable: true }));
          return;
        }
        // Heartbeat control traffic must remain live while a legitimate long
        // delivery owns the serialized work queue. It carries no execution
        // authority and does not alter delivery ordering.
        if (welcomed && frame.type === 'pong') {
          this.#lastPongAt = this.#clock().getTime();
          return;
        }
        messageQueue = messageQueue.then(() => processMessage(frame));
        void messageQueue.catch((error) => drainConnection(error instanceof OperatorError
          ? error
          : new OperatorError('RELAY_PROTOCOL_ERROR', error instanceof Error ? error.message : String(error), { retryable: true })));
      };

      socket.addEventListener('message', onMessage);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
      interrupt = (mode = 'reconnect') => {
        if (settled || reconnectRequested) return;
        if (mode === 'shutdown') {
          drainConnection(null);
          return;
        }
        drainConnection(new OperatorError('RELAY_RECONNECT_REQUESTED', 'Relay reconnect was requested after in-flight work drained.', { retryable: true }), true);
      };
      this.#interruptConnection = interrupt;
    });

    sendFrame(socket, { type: 'hello', payload: helloPayload, signature, sessionToken: token });
    await connectionDone;
    this.#clearHeartbeat();
    this.#socket = null;
  }

  async #validateWelcome(frame: WelcomeFrame, state: RelayState, supportedCapabilities: readonly string[]): Promise<{ capabilities: string[]; readConcurrency: number }> {
    if (frame.protocol !== PROTOCOL) throw new OperatorError('RELAY_PROTOCOL_VERSION', 'Relay protocol version mismatch.');
    let effectiveCapabilities = [...supportedCapabilities];
    if (this.#requireCapabilityBinding) {
      const legacyRelay = frame.capabilityBinding === undefined && frame.capabilities === undefined;
      if (!legacyRelay) {
        if (frame.capabilityBinding !== 1 || frame.capabilities === undefined) {
          throw new OperatorError('RELAY_CAPABILITY_BINDING_INVALID', 'Relay returned a partial or invalid capability-binding negotiation.', { retryable: false });
        }
        const effective = validateSupportedCapabilities(frame.capabilities);
        const advertised = new Set(supportedCapabilities);
        if (effective.some((capability) => !advertised.has(capability))) {
          throw new OperatorError('RELAY_CAPABILITY_BINDING_INVALID', 'Relay acknowledged a capability that the local runtime did not advertise.', { retryable: false });
        }
        effectiveCapabilities = effective;
      }
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(frame.connectionId)) throw new OperatorError('RELAY_PROTOCOL_ERROR', 'Relay connection ID is invalid.');
    if (frame.logicalSessionId !== undefined && validLogicalSessionId(frame.logicalSessionId) !== this.#logicalSessionId) {
      throw new OperatorError('RELAY_LOGICAL_SESSION_MISMATCH', 'Relay logical session acknowledgement does not match this running client.', { retryable: false });
    }
    if (!Number.isSafeInteger(frame.resumeFromSeq) || frame.resumeFromSeq < 0) throw new OperatorError('RELAY_PROTOCOL_ERROR', 'Relay resume sequence is invalid.');
    const expiredThroughSeq = frame.expiredThroughSeq;
    if (expiredThroughSeq !== undefined && (!Number.isSafeInteger(expiredThroughSeq) || expiredThroughSeq < 1 || expiredThroughSeq !== frame.resumeFromSeq)) {
      throw new OperatorError('RELAY_PROTOCOL_ERROR', 'Relay expired-history reconciliation proof is invalid.');
    }
    const readConcurrency = frame.readConcurrency === undefined ? 1 : boundedReadConcurrency(frame.readConcurrency);
    if (readConcurrency > this.#maxConcurrentReadDeliveries) {
      throw new OperatorError('RELAY_READ_CONCURRENCY_INVALID', 'Relay acknowledged a read concurrency higher than the client advertised.', { retryable: false });
    }
    if (frame.resumeFromSeq === state.lastAckedServerSeq) {
      if (expiredThroughSeq !== undefined) throw new OperatorError('RELAY_PROTOCOL_ERROR', 'Relay supplied an unnecessary expired-history reconciliation proof.');
      return { capabilities: effectiveCapabilities, readConcurrency };
    }
    if (frame.resumeFromSeq < state.lastAckedServerSeq || expiredThroughSeq !== frame.resumeFromSeq) {
      throw new OperatorError('RELAY_RESUME_MISMATCH', 'Relay resume cursor does not match the durable local acknowledgement cursor.', { retryable: true });
    }
    if (state.processing) {
      if (state.processing.seq > frame.resumeFromSeq || !this.#onExpiredRecovery) {
        throw new OperatorError('RELAY_RECOVERY_CONFLICT', 'Relay cannot skip expired history while a local delivery remains in uncertain processing state.', { retryable: false });
      }
      const decision = await this.#onExpiredRecovery({ processing: { ...state.processing }, expiredThroughSeq: frame.resumeFromSeq });
      if (decision !== 'ack') {
        throw new OperatorError('RELAY_RECOVERY_REQUIRED', 'Expired delivery recovery callback refused to reconcile the durable processing result.', { retryable: false });
      }
    }
    await this.#writeState({ version: 1, lastAckedServerSeq: frame.resumeFromSeq });
    if (state.processing && state.processing.seq <= frame.resumeFromSeq) {
      await this.#notifyAcknowledged(state.processing);
    }
    return { capabilities: effectiveCapabilities, readConcurrency };
  }

  #emitStatus(status: RelayClientStatus): void {
    try { this.#onStatus?.(status); } catch { /* diagnostics must not affect relay authority */ }
  }

  #emitConnectionState(status: RelayConnectionState): void {
    try { this.#onConnectionState?.(status); } catch { /* diagnostics must not affect relay authority */ }
  }

  async #handleDelivery(socket: RelaySocketLike, frame: DeliveryFrame): Promise<void> {
    const delivery = validateDelivery(frame);
    let state = await this.#readState();

    if (delivery.seq <= state.lastAckedServerSeq) {
      await this.#notifyAcknowledged(delivery);
      sendAckFrame(socket, { type: 'ack', seq: delivery.seq, id: delivery.id, duplicate: true });
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
        await this.#notifyAcknowledged(delivery);
        sendAckFrame(socket, { type: 'ack', seq: delivery.seq, id: delivery.id, recovered: true });
        return;
      } else {
        throw new OperatorError('RELAY_RECOVERY_REQUIRED', 'Recovery callback returned an invalid decision.', { retryable: false });
      }
    }

    const processing: RelayState['processing'] = { seq: delivery.seq, id: delivery.id, startedAt: this.#clock().toISOString() };
    await this.#writeState({ ...state, processing });
    await this.#onDelivery(delivery);
    await this.#writeState({ version: 1, lastAckedServerSeq: delivery.seq });
    await this.#notifyAcknowledged(delivery);
    sendAckFrame(socket, { type: 'ack', seq: delivery.seq, id: delivery.id });
  }

  async #notifyAcknowledged(delivery: Pick<RelayDelivery, 'seq' | 'id'>): Promise<void> {
    try { await this.#onAcknowledged?.({ seq: delivery.seq, id: delivery.id }); }
    catch { /* acknowledgement is already durable; cleanup is best-effort */ }
  }

  #startHeartbeat(socket: RelaySocketLike, heartbeatMs: number): void {
    this.#clearHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      if (this.#clock().getTime() - this.#lastPongAt > heartbeatMs * 3) {
        this.#emitConnectionState({ state: 'DEGRADED', code: 'RELAY_HEARTBEAT_TIMEOUT', recoverable: true });
        try { socket.close(4000, 'heartbeat timeout'); } catch { /* noop */ }
        return;
      }
      const nonce = crypto.randomBytes(12).toString('base64url');
      try { sendFrame(socket, { type: 'ping', nonce, at: this.#clock().toISOString() }); } catch { /* close path handles reconnect */ }
    }, heartbeatMs);
    this.#heartbeatTimer.unref();
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
  }

  async #readState(): Promise<RelayState> {
    try {
      const text = await readDurableStateText(this.#stateFile, {
        maxBytes: 64 * 1024,
        errorCode: 'RELAY_STATE_CORRUPT',
        invalidMessage: 'Relay client state is invalid.'
      });
      return validateState(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, lastAckedServerSeq: 0 };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('RELAY_STATE_CORRUPT', 'Relay client state could not be read.');
    }
  }

  async #writeState(stateInput: RelayState): Promise<void> {
    const state = validateState(stateInput);
    await writeDurableStateText(this.#stateFile, JSON.stringify(state, null, 2), {
      maxBytes: 64 * 1024,
      errorCode: 'RELAY_STATE_CORRUPT',
      invalidMessage: 'Relay client state is invalid.'
    });
  }
}

function isRevocationCode(code: string): boolean {
  return code === 'DEVICE_REVOKED'
    || code === 'SESSION_REVOKED'
    || code === 'ACCOUNT_DISABLED'
    || code === 'RELAY_AUTHORITY_CHANGED';
}

export function reconnectDelay(attemptInput: number, randomInput = Math.random()): number {
  const attempt = Math.min(Math.max(Math.trunc(attemptInput), 0), 20);
  const random = Number.isFinite(randomInput) ? Math.min(Math.max(randomInput, 0), 1) : 0.5;
  const base = Math.min(MIN_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  const jitter = 0.75 + random * 0.5;
  return Math.min(Math.max(Math.round(base * jitter), MIN_BACKOFF_MS), MAX_BACKOFF_MS);
}


function boundedReadConcurrency(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_CONCURRENT_READS) {
    throw new OperatorError('RELAY_READ_CONCURRENCY_INVALID', `Relay read concurrency must be an integer between 1 and ${MAX_CONCURRENT_READS}.`);
  }
  return parsed;
}

function isConcurrentReadDelivery(delivery: RelayDelivery): boolean {
  if (delivery.kind !== 'action') return false;
  const action = delivery.payload.action;
  return Boolean(action && typeof action === 'object' && !Array.isArray(action) && (action as Record<string, unknown>).risk === 'read');
}

function validateResourceProfile(input: RelayResourceProfile): RelayResourceProfile {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('RELAY_RESOURCE_PROFILE_INVALID', 'Relay resource profile is invalid.');
  const cpuSlots = Number(input.cpuSlots);
  const memoryMb = Number(input.memoryMb);
  const maxConcurrentJobs = Number(input.maxConcurrentJobs);
  if (!Number.isSafeInteger(cpuSlots) || cpuSlots < 1 || cpuSlots > 1024) throw new OperatorError('RELAY_RESOURCE_PROFILE_INVALID', 'cpuSlots is invalid.');
  if (!Number.isSafeInteger(memoryMb) || memoryMb < 128 || memoryMb > 16 * 1024 * 1024) throw new OperatorError('RELAY_RESOURCE_PROFILE_INVALID', 'memoryMb is invalid.');
  if (!Number.isSafeInteger(maxConcurrentJobs) || maxConcurrentJobs < 1 || maxConcurrentJobs > 1024) throw new OperatorError('RELAY_RESOURCE_PROFILE_INVALID', 'maxConcurrentJobs is invalid.');
  if (!Array.isArray(input.tags) || input.tags.length > 64) throw new OperatorError('RELAY_RESOURCE_PROFILE_INVALID', 'resource tags are invalid.');
  const tags = input.tags.map((tag, index) => {
    if (typeof tag !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(tag)) throw new OperatorError('RELAY_RESOURCE_PROFILE_INVALID', `resource tag ${index} is invalid.`);
    return tag;
  });
  if (new Set(tags).size !== tags.length) throw new OperatorError('RELAY_RESOURCE_PROFILE_INVALID', 'resource tags contain duplicates.');
  return { cpuSlots, memoryMb, gpu: input.gpu === true, tags: tags.sort(), maxConcurrentJobs };
}

function validateSupportedCapabilities(input: readonly string[]): string[] {
  if (!Array.isArray(input) || input.length > 128) {
    throw new OperatorError('RELAY_CAPABILITIES_INVALID', 'Relay supported capabilities must be a bounded array.');
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const capability = String(item ?? '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(capability)) {
      throw new OperatorError('RELAY_CAPABILITIES_INVALID', 'Relay supported capability name is invalid.');
    }
    if (seen.has(capability)) continue;
    seen.add(capability);
    output.push(capability);
  }
  return output.sort();
}

function sameRelayDestination(expectedRaw: string, actualRaw: string): boolean {
  try { return new URL(expectedRaw).toString() === new URL(actualRaw).toString(); } catch { return false; }
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

function validLogicalSessionId(value: string): string {
  const normalized = String(value ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new OperatorError('RELAY_LOGICAL_SESSION_INVALID', 'Relay logical session ID must be a UUID.', { retryable: false });
  }
  return normalized;
}

function validIso(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new OperatorError('RELAY_STATE_CORRUPT', 'Relay state timestamp is invalid.');
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

function sendAckFrame(socket: RelaySocketLike, frame: JsonObject): void {
  // The durable cursor/result is authoritative. If the transport disappeared
  // after that commit, the next hello reconciles the cursor instead of turning
  // a harmless lost ACK frame into a delivery failure.
  if (socket.readyState !== 1) return;
  sendFrame(socket, frame);
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

function waitForOpen(socket: RelaySocketLike, timeoutMs: number): Promise<void> {
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onOpen = () => finish(resolve);
    const onError = () => finish(() => reject(new OperatorError('RELAY_CONNECT_FAILED', 'Relay socket failed before opening.', { retryable: true })));
    const onClose = () => finish(() => reject(new OperatorError('RELAY_CONNECT_FAILED', 'Relay socket closed before opening.', { retryable: true })));
    const timer = setTimeout(() => finish(() => {
      try { socket.close(4001, 'connect timeout'); } catch { /* timeout failure is already authoritative */ }
      reject(new OperatorError('RELAY_CONNECT_TIMEOUT', `Relay socket did not open within ${timeoutMs}ms.`, { retryable: true }));
    }), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener?.('open', onOpen);
      socket.removeEventListener?.('error', onError);
      socket.removeEventListener?.('close', onClose);
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
  });
}

function boundedConnectTimeout(value: unknown): number {
  const parsed = Number(value ?? DEFAULT_CONNECT_TIMEOUT_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_CONNECT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(parsed), MIN_CONNECT_TIMEOUT_MS), MAX_CONNECT_TIMEOUT_MS);
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
