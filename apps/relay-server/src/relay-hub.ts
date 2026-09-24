import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { AccountDeviceRegistry } from '../../../src/core/account-device-registry.ts';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { DeviceRegistryStore } from '../../../src/core/device-registry.ts';
import { DeviceRoutingStore, type DeviceRouteDecision, type OnlineDeviceDescriptor } from '../../../src/core/device-routing.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { applyBoundedHttpServerPolicy } from '../../../src/core/network-authority.ts';
import { FixedWindowRateLimiter, requestClientKey } from '../../../src/core/rate-limit.ts';
import { RelayDeliveryStore, type RelayDeliveryAuthority, type StoredRelayDelivery } from '../../../src/core/relay-delivery-store.ts';
import { DeviceSessionTokenStore } from '../../../src/core/session-token.ts';

const MAX_FRAME_BYTES = 256 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const HELLO_CLOCK_SKEW_MS = 2 * 60_000;
const HEARTBEAT_MS = 20_000;
const DEFAULT_UPGRADE_LIMIT_PER_MINUTE = 120;
const DEFAULT_DEVICE_HELLO_LIMIT_PER_FIVE_MINUTES = 60;
const DEFAULT_MAX_LIVE_CONNECTIONS = 5_000;
const DEFAULT_MAX_LIVE_CONNECTIONS_PER_CLIENT = 64;

type JsonObject = Record<string, unknown>;

type Connection = {
  socket: WebSocket;
  deviceId: string;
  sessionId: string;
  sessionJti: string;
  capabilities: string[];
  connectedAt: string;
  lastSeenAt: string;
  inFlightSeq?: number;
};

export interface RelayHubOptions {
  stateDir: string;
  identity?: DeviceIdentityStore;
  devices?: DeviceRegistryStore;
  sessions?: DeviceSessionTokenStore;
  accounts?: AccountDeviceRegistry;
  deliveries?: RelayDeliveryStore;
  clock?: () => Date;
  beforeEnqueue?: (authority: RelayDeliveryAuthority) => Promise<void> | void;
  upgradeLimitPerMinute?: number;
  deviceHelloLimitPerFiveMinutes?: number;
  maxLiveConnections?: number;
  maxLiveConnectionsPerClient?: number;
}

export interface RelayDispatchRequest {
  accountId: string;
  explicitDeviceId?: string;
  projectKey?: string;
  requiredCapabilities?: string[];
  kind: string;
  payload: JsonObject;
  idempotencyKey?: string;
}

export interface RelayDispatchResult {
  route: DeviceRouteDecision;
  delivery: StoredRelayDelivery;
}

export class RelayHub {
  #stateDir: string;
  #identity: DeviceIdentityStore;
  #devices: DeviceRegistryStore;
  #sessions: DeviceSessionTokenStore;
  #accounts: AccountDeviceRegistry;
  #deliveries: RelayDeliveryStore;
  #clock: () => Date;
  #beforeEnqueue?: (authority: RelayDeliveryAuthority) => Promise<void> | void;
  #server: http.Server | null = null;
  #wss: WebSocketServer | null = null;
  #connections = new Map<string, Connection>();
  #routing = new Map<string, DeviceRoutingStore>();
  #upgradeLimiter: FixedWindowRateLimiter;
  #deviceHelloLimiter: FixedWindowRateLimiter;
  #maxLiveConnections: number;
  #maxLiveConnectionsPerClient: number;
  #liveByClientKey = new Map<string, number>();
  #socketWork = new Set<Promise<void>>();

  constructor(options: RelayHubOptions) {
    this.#stateDir = path.resolve(options.stateDir);
    this.#identity = options.identity ?? new DeviceIdentityStore(this.#stateDir);
    this.#devices = options.devices ?? new DeviceRegistryStore(this.#stateDir);
    this.#sessions = options.sessions ?? new DeviceSessionTokenStore(this.#stateDir, this.#identity, this.#devices);
    this.#accounts = options.accounts ?? new AccountDeviceRegistry(this.#stateDir, this.#devices);
    this.#deliveries = options.deliveries ?? new RelayDeliveryStore(this.#stateDir);
    this.#clock = options.clock ?? (() => new Date());
    this.#beforeEnqueue = options.beforeEnqueue;
    const upgradeLimit = boundedPositiveInt(options.upgradeLimitPerMinute, DEFAULT_UPGRADE_LIMIT_PER_MINUTE, 100_000, 'upgradeLimitPerMinute');
    const helloLimit = boundedPositiveInt(options.deviceHelloLimitPerFiveMinutes, DEFAULT_DEVICE_HELLO_LIMIT_PER_FIVE_MINUTES, 100_000, 'deviceHelloLimitPerFiveMinutes');
    this.#maxLiveConnections = boundedPositiveInt(options.maxLiveConnections, DEFAULT_MAX_LIVE_CONNECTIONS, 100_000, 'maxLiveConnections');
    this.#maxLiveConnectionsPerClient = boundedPositiveInt(options.maxLiveConnectionsPerClient, DEFAULT_MAX_LIVE_CONNECTIONS_PER_CLIENT, this.#maxLiveConnections, 'maxLiveConnectionsPerClient');
    this.#upgradeLimiter = new FixedWindowRateLimiter({ limit: upgradeLimit, windowMs: 60_000 });
    this.#deviceHelloLimiter = new FixedWindowRateLimiter({ limit: helloLimit, windowMs: 5 * 60_000 });
  }

  async listen(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
    if (this.#server) throw new OperatorError('RELAY_ALREADY_LISTENING', 'Relay hub is already listening.');
    const server = http.createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: true, service: 'operator-relay', version: 1 }));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: 'not_found' }));
    });
    applyBoundedHttpServerPolicy(server);
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
    server.on('upgrade', (request, socket, head) => {
      let url: URL;
      try { url = new URL(request.url ?? '/', 'http://relay.invalid'); } catch { socket.destroy(); return; }
      if (url.pathname !== '/device') { socket.destroy(); return; }
      const clientKey = requestClientKey(request);
      const decision = this.#upgradeLimiter.hit(clientKey);
      if (!decision.allowed) { rejectUpgrade(socket, 429, 'Too Many Requests', decision.retryAfterSeconds); return; }
      if (wss.clients.size >= this.#maxLiveConnections || (this.#liveByClientKey.get(clientKey) ?? 0) >= this.#maxLiveConnectionsPerClient) {
        rejectUpgrade(socket, 429, 'Connection limit reached', 5);
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    });
    wss.on('connection', (socket, request) => {
      const clientKey = requestClientKey(request);
      this.#liveByClientKey.set(clientKey, (this.#liveByClientKey.get(clientKey) ?? 0) + 1);
      socket.once('close', () => {
        const remaining = (this.#liveByClientKey.get(clientKey) ?? 1) - 1;
        if (remaining > 0) this.#liveByClientKey.set(clientKey, remaining); else this.#liveByClientKey.delete(clientKey);
      });
      this.#accept(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new OperatorError('RELAY_LISTEN_FAILED', 'Relay server did not expose a TCP port.');
    this.#server = server;
    this.#wss = wss;
    return { host, port: address.port };
  }

  async close(): Promise<void> {
    for (const connection of this.#connections.values()) {
      try { connection.socket.close(1001, 'relay shutting down'); } catch { /* noop */ }
    }
    this.#connections.clear();
    const wss = this.#wss;
    const server = this.#server;
    this.#wss = null;
    this.#server = null;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    while (this.#socketWork.size > 0) {
      await Promise.allSettled([...this.#socketWork]);
    }
  }

  async onlineDevices(accountId?: string): Promise<OnlineDeviceDescriptor[]> {
    let allowed: Set<string> | null = null;
    if (accountId) allowed = new Set((await this.#accounts.listDevices(accountId)).map((membership) => membership.deviceId));
    return [...this.#connections.values()]
      .filter((connection) => !allowed || allowed.has(connection.deviceId))
      .map((connection) => ({
        deviceId: connection.deviceId,
        sessionId: connection.sessionId,
        capabilities: [...connection.capabilities],
        connectedAt: connection.connectedAt,
        lastSeenAt: connection.lastSeenAt
      }));
  }

  async bindProject(accountId: string, projectKey: string, deviceId: string): Promise<void> {
    if (!(await this.#accounts.ownsDevice(accountId, deviceId))) {
      throw new OperatorError('ACCOUNT_DEVICE_NOT_OWNED', 'Project can only be bound to an active device owned by the account.');
    }
    await this.#routingFor(accountId).bindProject(projectKey, deviceId);
  }

  async setDefaultDevice(accountId: string, deviceId: string): Promise<void> {
    const membership = await this.#accounts.activeMembershipForDevice(deviceId);
    if (!membership || membership.accountId !== accountId) {
      throw new OperatorError('ACCOUNT_DEVICE_NOT_OWNED', 'Default routing can only select an active device owned by the account.');
    }
    await this.#accounts.withActiveAuthorityLease({
      accountId,
      deviceId,
      generation: membership.authorityGeneration
    }, async () => {
      await this.#routingFor(accountId).setDefaultDevice(deviceId);
    });
  }

  async boundProjectDevice(accountId: string, projectKey: string): Promise<string> {
    const binding = (await this.#routingFor(accountId).listBindings()).find((candidate) => candidate.projectKey === projectKey);
    if (!binding) throw new OperatorError('ROUTE_PROJECT_UNBOUND', 'Required task-to-device binding is missing.');
    if (!(await this.#accounts.ownsDevice(accountId, binding.deviceId))) {
      throw new OperatorError('ACCOUNT_DEVICE_NOT_OWNED', 'Bound task device is no longer actively owned by the account.');
    }
    return binding.deviceId;
  }

  async dispatch(request: RelayDispatchRequest): Promise<RelayDispatchResult> {
    const requiredCapabilities = request.requiredCapabilities ?? [];
    const memberships = await this.#accounts.listDevices(request.accountId);
    const owned = new Set(memberships.map((membership) => membership.deviceId));
    const online = (await this.onlineDevices(request.accountId)).filter((device) => owned.has(device.deviceId));
    const route = await this.#routingFor(request.accountId).resolve({
      explicitDeviceId: request.explicitDeviceId,
      projectKey: request.projectKey,
      requiredCapabilities
    }, online);
    const membership = memberships.find((candidate) => candidate.deviceId === route.deviceId && candidate.status === 'active');
    if (!membership) throw new OperatorError('ACCOUNT_DEVICE_NOT_OWNED', 'Resolved device has no active account authority.');
    const authority: RelayDeliveryAuthority = {
      accountId: request.accountId,
      deviceId: route.deviceId,
      generation: membership.authorityGeneration
    };
    await this.#beforeEnqueue?.({ ...authority });
    await this.#assertDispatchAuthority(authority, route.sessionId, requiredCapabilities);
    const payload = { ...request.payload, approvalAuthority: { ...authority } };
    let delivery: StoredRelayDelivery;
    try {
      delivery = await this.#accounts.withActiveAuthorityLease(authority, async () =>
        await this.#deliveries.enqueue(route.deviceId, request.kind, payload, authority, request.idempotencyKey, requiredCapabilities));
    } catch (error) {
      if (error instanceof OperatorError && error.code === 'ACCOUNT_AUTHORITY_REVOKED') {
        throw new OperatorError('RELAY_AUTHORITY_CHANGED', 'Account-device authority changed before relay delivery commit.');
      }
      throw error;
    }
    let postEnqueueAuthorityError: unknown;
    try {
      await this.#assertDispatchAuthority(authority, route.sessionId, requiredCapabilities);
    } catch (error) {
      postEnqueueAuthorityError = error;
    }
    await this.#pump(route.deviceId);
    const retained = await this.#deliveries.retained(route.deviceId, delivery.seq);
    if (retained?.status === 'expired') {
      throw new OperatorError('RELAY_DELIVERY_CAPABILITY_RETIRED', 'Relay delivery became incompatible with the active device capabilities before execution.', { retryable: true });
    }
    if (postEnqueueAuthorityError) throw postEnqueueAuthorityError;
    const finalConnection = await this.#assertDispatchAuthority(authority, route.sessionId, requiredCapabilities);
    this.#assertCurrentDispatchConnection(finalConnection, requiredCapabilities);
    return { route, delivery };
  }

  async recoverIdempotent(idempotencyKey: string): Promise<{ deviceId: string; delivery: StoredRelayDelivery } | null> {
    return await this.#deliveries.findIdempotent(idempotencyKey);
  }

  async deliveryCursor(deviceId: string): Promise<{ lastAckedSeq: number; highestEnqueuedSeq: number }> {
    return await this.#deliveries.cursor(deviceId);
  }

  invalidateDevice(deviceIdInput: string, reason = 'device authority revoked'): boolean {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const connection = this.#connections.get(deviceId);
    if (!connection) return false;
    this.#connections.delete(deviceId);
    connection.inFlightSeq = undefined;
    try { connection.socket.close(4004, boundedCloseReason(reason)); } catch { /* authority is already removed locally */ }
    return true;
  }

  invalidateSession(jtiInput: string, reason = 'session authority revoked'): number {
    const jti = validUuid(jtiInput, 'session jti');
    let closed = 0;
    for (const connection of [...this.#connections.values()]) {
      if (connection.sessionJti !== jti) continue;
      if (this.invalidateDevice(connection.deviceId, reason)) closed += 1;
    }
    return closed;
  }

  #routingFor(accountId: string): DeviceRoutingStore {
    let store = this.#routing.get(accountId);
    if (!store) {
      store = new DeviceRoutingStore(path.join(this.#stateDir, 'accounts', accountId), this.#devices, { clock: this.#clock });
      this.#routing.set(accountId, store);
    }
    return store;
  }

  #accept(socket: WebSocket): void {
    let authenticated = false;
    let connection: Connection | null = null;
    let messageQueue: Promise<void> = Promise.resolve();
    const timer = setTimeout(() => {
      if (!authenticated) socket.close(4008, 'hello timeout');
    }, HANDSHAKE_TIMEOUT_MS);
    timer.unref();

    const fail = (error: unknown) => {
      const code = error instanceof OperatorError ? error.code : 'RELAY_PROTOCOL_ERROR';
      try { socket.close(4002, code.slice(0, 120)); } catch { /* noop */ }
    };

    socket.on('message', (data, isBinary) => {
      const work = messageQueue.then(async () => {
        if (isBinary) throw new OperatorError('RELAY_FRAME_INVALID', 'Binary relay frames are not accepted.');
        const frame = parseFrame(data.toString('utf8'));
        if (!authenticated) {
          if (frame.type !== 'hello') throw new OperatorError('RELAY_HELLO_REQUIRED', 'First relay frame must be hello.');
          connection = await this.#authenticateHello(socket, frame);
          authenticated = true;
          clearTimeout(timer);
          await this.#pump(connection.deviceId);
          return;
        }
        if (!connection) throw new OperatorError('RELAY_PROTOCOL_ERROR', 'Authenticated relay connection state is missing.');
        connection.lastSeenAt = this.#clock().toISOString();
        if (frame.type === 'ping') {
          const nonce = validNonce(String(frame.nonce ?? ''));
          send(socket, { type: 'pong', nonce });
          return;
        }
        if (frame.type === 'ack') {
          const seq = Number(frame.seq);
          const id = String(frame.id ?? '');
          await this.#deliveries.acknowledge(connection.deviceId, seq, id);
          connection.inFlightSeq = undefined;
          await this.#pump(connection.deviceId);
          return;
        }
        throw new OperatorError('RELAY_PROTOCOL_ERROR', 'Unsupported authenticated relay frame.');
      });
      messageQueue = work;
      this.#socketWork.add(work);
      void work.finally(() => this.#socketWork.delete(work)).catch(() => undefined);
      void work.catch(fail);
    });

    socket.on('close', () => {
      clearTimeout(timer);
      if (connection && this.#connections.get(connection.deviceId)?.sessionId === connection.sessionId) {
        this.#connections.delete(connection.deviceId);
      }
    });
    socket.on('error', () => { /* close lifecycle owns cleanup */ });
  }

  async #authenticateHello(socket: WebSocket, frame: any): Promise<Connection> {
    const payload = frame.payload;
    if (!payload || typeof payload !== 'object' || payload.protocol !== 1) throw new OperatorError('RELAY_HELLO_INVALID', 'Relay hello payload is invalid.');
    const deviceId = validUuid(String(payload.deviceId ?? ''), 'deviceId');
    const helloDecision = this.#deviceHelloLimiter.hit(`device:${deviceId}`);
    if (!helloDecision.allowed) throw new OperatorError('RELAY_RATE_LIMITED', 'Relay device authentication attempts are rate limited.', { retryable: true });
    const fingerprint = String(payload.fingerprint ?? '');
    const resumeAfterSeq = Number(payload.resumeAfterSeq ?? 0);
    if (!Number.isSafeInteger(resumeAfterSeq) || resumeAfterSeq < 0) throw new OperatorError('RELAY_HELLO_INVALID', 'Relay resume cursor is invalid.');
    const sentAt = validIso(String(payload.sentAt ?? ''), 'sentAt');
    if (Math.abs(this.#clock().getTime() - Date.parse(sentAt)) > HELLO_CLOCK_SKEW_MS) throw new OperatorError('RELAY_HELLO_STALE', 'Relay hello timestamp is outside the accepted clock-skew window.');
    validNonce(String(payload.nonce ?? ''));
    if (payload.capabilityBinding !== undefined && payload.capabilityBinding !== 1) {
      throw new OperatorError('RELAY_HELLO_INVALID', 'Relay hello capability-binding negotiation is invalid.');
    }
    // During rollout, legacy clients send neither field. A short-lived pre-negotiation client may
    // send capabilities without the explicit request, so presence of either signal opts into binding.
    const capabilityBindingRequested = payload.capabilityBinding === 1 || payload.capabilities !== undefined;
    if (payload.capabilityBinding === 1 && payload.capabilities === undefined) {
      throw new OperatorError('RELAY_HELLO_INVALID', 'Capability-binding negotiation requires an explicit capability list.');
    }
    const locallySupportedCapabilities = capabilityBindingRequested ? validCapabilityList(payload.capabilities) : [];
    const signature = String(frame.signature ?? '');
    if (!/^[A-Za-z0-9_-]{40,256}$/.test(signature)) throw new OperatorError('RELAY_HELLO_INVALID', 'Relay hello signature is invalid.');
    const token = String(frame.sessionToken ?? '');
    const session = await this.#sessions.verify(token, {
      audience: 'operator-relay',
      requiredScopes: ['relay:connect'],
      expectedSubjectDeviceId: deviceId
    });
    const registered = (await this.#devices.listDevices()).find((device) => device.deviceId === deviceId);
    if (!registered || registered.status !== 'active') throw new OperatorError('DEVICE_REVOKED', 'Relay device is not an active paired device.');
    if (registered.fingerprint !== fingerprint || session.subjectFingerprint !== fingerprint) throw new OperatorError('RELAY_HELLO_IDENTITY_MISMATCH', 'Relay hello fingerprint does not match paired/session identity.');
    const signatureOk = await this.#devices.verifyDeviceSignature(deviceId, Buffer.from(JSON.stringify(payload), 'utf8'), signature);
    if (!signatureOk) throw new OperatorError('RELAY_HELLO_SIGNATURE_INVALID', 'Relay hello signature could not be verified.');

    const authorizedCapabilities = new Set(session.scopes.filter((scope) => scope.startsWith('cap:')).map((scope) => scope.slice(4)).filter(Boolean));
    const capabilities = capabilityBindingRequested
      ? locallySupportedCapabilities.filter((capability) => authorizedCapabilities.has(capability))
      : [...authorizedCapabilities].sort();
    const reconciled = await this.#deliveries.reconcileClientCursor(deviceId, resumeAfterSeq);
    const sessionId = crypto.randomUUID();
    const now = this.#clock().toISOString();
    const previous = this.#connections.get(deviceId);
    if (previous) {
      try { previous.socket.close(4001, 'connection superseded'); } catch { /* noop */ }
    }
    const connection: Connection = { socket, deviceId, sessionId, sessionJti: session.jti, capabilities, connectedAt: now, lastSeenAt: now };
    this.#connections.set(deviceId, connection);
    send(socket, {
      type: 'welcome',
      protocol: 1,
      connectionId: sessionId,
      resumeFromSeq: reconciled.lastAckedSeq,
      ...(reconciled.expiredThroughSeq === undefined ? {} : { expiredThroughSeq: reconciled.expiredThroughSeq }),
      heartbeatMs: HEARTBEAT_MS,
      ...(capabilityBindingRequested ? { capabilityBinding: 1, capabilities: [...capabilities] } : {})
    });
    return connection;
  }

  async #assertDispatchAuthority(authority: RelayDeliveryAuthority, expectedSessionId?: string, requiredCapabilities: string[] = []): Promise<Connection> {
    let memberships;
    try {
      memberships = await this.#accounts.listDevices(authority.accountId);
    } catch (error) {
      if (error instanceof OperatorError && ['ACCOUNT_NOT_FOUND', 'ACCOUNT_DISABLED'].includes(error.code)) {
        throw new OperatorError('RELAY_AUTHORITY_CHANGED', 'Account authority changed before relay delivery could be authorized.');
      }
      throw error;
    }
    const current = memberships.find((membership) => membership.deviceId === authority.deviceId && membership.status === 'active');
    if (!current || current.authorityGeneration !== authority.generation) {
      throw new OperatorError('RELAY_AUTHORITY_CHANGED', 'Account-device authority changed before relay delivery could be authorized.');
    }
    const connection = this.#connections.get(authority.deviceId);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN || (expectedSessionId && connection.sessionId !== expectedSessionId)) {
      throw new OperatorError('RELAY_AUTHORITY_CHANGED', 'Relay connection changed before delivery could be authorized.', { retryable: true });
    }
    if (!(await this.#sessions.isActive(connection.sessionJti, authority.deviceId))) {
      this.invalidateSession(connection.sessionJti, 'session no longer active');
      throw new OperatorError('RELAY_AUTHORITY_CHANGED', 'Relay session is no longer active.');
    }
    const missing = requiredCapabilities.filter((capability) => !connection.capabilities.includes(capability));
    if (missing.length > 0) throw new OperatorError('RELAY_AUTHORITY_CHANGED', 'Relay connection capabilities changed before delivery authorization.');
    return connection;
  }

  #assertCurrentDispatchConnection(expected: Connection, requiredCapabilities: string[]): void {
    const current = this.#connections.get(expected.deviceId);
    if (current !== expected || current.socket.readyState !== WebSocket.OPEN) {
      throw new OperatorError('RELAY_AUTHORITY_CHANGED', 'Relay connection changed before dispatch success could be committed.', { retryable: true });
    }
    const missing = requiredCapabilities.filter((capability) => !current.capabilities.includes(capability));
    if (missing.length > 0) {
      throw new OperatorError('RELAY_AUTHORITY_CHANGED', 'Relay connection capabilities changed before dispatch success could be committed.', { retryable: true });
    }
  }

  async #pump(deviceId: string): Promise<void> {
    const connection = this.#connections.get(deviceId);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN || connection.inFlightSeq !== undefined) return;
    const [next] = await this.#deliveries.pending(deviceId, 1);
    if (!next) return;
    const requiredCapabilities = next.requiredCapabilities;
    const missingCapabilities = requiredCapabilities?.filter((capability) => !connection.capabilities.includes(capability)) ?? [];
    const unroutable = !next.authority || requiredCapabilities === undefined || missingCapabilities.length > 0;
    if (unroutable) {
      if (next.authority) await this.#assertDispatchAuthority(next.authority, connection.sessionId);
      const capabilitySnapshot = [...connection.capabilities];
      const isCurrentSnapshot = () => {
        const active = this.#connections.get(deviceId);
        return active?.sessionId === connection.sessionId
          && active.socket === connection.socket
          && active.socket.readyState === WebSocket.OPEN
          && active.capabilities.length === capabilitySnapshot.length
          && active.capabilities.every((capability, index) => capability === capabilitySnapshot[index]);
      };
      const retired = await this.#deliveries.expireUnroutableHeads(deviceId, capabilitySnapshot, isCurrentSnapshot);
      if (retired > 0 && isCurrentSnapshot()) {
        this.#connections.delete(deviceId);
        connection.inFlightSeq = undefined;
        try { connection.socket.close(4009, 'capability queue reconciliation'); } catch { /* reconnect will reconcile the durable cursor */ }
      }
      return;
    }
    await this.#assertDispatchAuthority(next.authority, connection.sessionId, requiredCapabilities);
    connection.inFlightSeq = next.seq;
    try {
      send(connection.socket, { type: 'delivery', seq: next.seq, id: next.id, kind: next.kind, payload: next.payload });
    } catch (error) {
      connection.inFlightSeq = undefined;
      throw error;
    }
  }
}

function parseFrame(text: string): any {
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) throw new OperatorError('RELAY_FRAME_INVALID', 'Relay frame is missing or exceeds the bounded size.');
  let value: any;
  try { value = JSON.parse(text); } catch { throw new OperatorError('RELAY_FRAME_INVALID', 'Relay frame is not valid JSON.'); }
  if (!value || typeof value !== 'object' || typeof value.type !== 'string') throw new OperatorError('RELAY_FRAME_INVALID', 'Relay frame must be an object with a type.');
  return value;
}

function send(socket: WebSocket, frame: JsonObject): void {
  const text = JSON.stringify(frame);
  if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) throw new OperatorError('RELAY_FRAME_TOO_LARGE', 'Relay outbound frame exceeds the bounded size.');
  socket.send(text);
}

function boundedCloseReason(value: string): string {
  const text = String(value ?? 'authority revoked').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return (text || 'authority revoked').slice(0, 120);
}


function validCapabilityList(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 128) throw new OperatorError('RELAY_HELLO_INVALID', 'Relay hello capabilities are invalid.');
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const capability = String(item ?? '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(capability) || seen.has(capability)) {
      throw new OperatorError('RELAY_HELLO_INVALID', 'Relay hello capabilities are invalid.');
    }
    seen.add(capability);
    output.push(capability);
  }
  return output.sort();
}

function validNonce(value: string): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new OperatorError('RELAY_NONCE_INVALID', 'Relay nonce is invalid.');
  return value;
}

function validUuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new OperatorError('RELAY_ID_INVALID', `${label} must be a UUID.`);
  return value.toLowerCase();
}

function validIso(value: string, label: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new OperatorError('RELAY_TIME_INVALID', `${label} must be an ISO timestamp.`);
  return value;
}
function rejectUpgrade(socket: { write(data: string): unknown; destroy(): unknown }, status: number, message: string, retryAfterSeconds: number): void {
  const body = `${status} ${message}\n`;
  const retry = Math.max(1, Math.min(Math.trunc(retryAfterSeconds), 3600));
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nRetry-After: ${retry}\r\n\r\n${body}`);
  } finally {
    socket.destroy();
  }
}

function boundedPositiveInt(value: number | undefined, fallback: number, max: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 1 || selected > max) {
    throw new OperatorError('RELAY_LIMIT_CONFIG_INVALID', `${label} must be an integer between 1 and ${max}.`);
  }
  return selected;
}
