import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { AccountDeviceRegistry } from '../../../src/core/account-device-registry.ts';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { DeviceRegistryStore } from '../../../src/core/device-registry.ts';
import { DeviceRoutingStore, type DeviceRouteDecision, type OnlineDeviceDescriptor } from '../../../src/core/device-routing.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { RelayDeliveryStore, type StoredRelayDelivery } from '../../../src/core/relay-delivery-store.ts';
import { DeviceSessionTokenStore } from '../../../src/core/session-token.ts';

const MAX_FRAME_BYTES = 256 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const HELLO_CLOCK_SKEW_MS = 2 * 60_000;
const HEARTBEAT_MS = 20_000;

type JsonObject = Record<string, unknown>;

type Connection = {
  socket: WebSocket;
  deviceId: string;
  sessionId: string;
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
}

export interface RelayDispatchRequest {
  accountId: string;
  explicitDeviceId?: string;
  projectKey?: string;
  requiredCapabilities?: string[];
  kind: string;
  payload: JsonObject;
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
  #server: http.Server | null = null;
  #wss: WebSocketServer | null = null;
  #connections = new Map<string, Connection>();
  #routing = new Map<string, DeviceRoutingStore>();

  constructor(options: RelayHubOptions) {
    this.#stateDir = path.resolve(options.stateDir);
    this.#identity = options.identity ?? new DeviceIdentityStore(this.#stateDir);
    this.#devices = options.devices ?? new DeviceRegistryStore(this.#stateDir);
    this.#sessions = options.sessions ?? new DeviceSessionTokenStore(this.#stateDir, this.#identity, this.#devices);
    this.#accounts = options.accounts ?? new AccountDeviceRegistry(this.#stateDir, this.#devices);
    this.#deliveries = options.deliveries ?? new RelayDeliveryStore(this.#stateDir);
    this.#clock = options.clock ?? (() => new Date());
  }

  async listen(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
    if (this.#server) throw new OperatorError('RELAY_ALREADY_LISTENING', 'Relay hub is already listening.');
    const server = http.createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: true, service: 'operator-relay', version: 1, onlineDevices: this.#connections.size }));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: 'not_found' }));
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
    server.on('upgrade', (request, socket, head) => {
      let url: URL;
      try { url = new URL(request.url ?? '/', 'http://relay.invalid'); } catch { socket.destroy(); return; }
      if (url.pathname !== '/device') { socket.destroy(); return; }
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    });
    wss.on('connection', (socket) => this.#accept(socket));
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

  async dispatch(request: RelayDispatchRequest): Promise<RelayDispatchResult> {
    const memberships = await this.#accounts.listDevices(request.accountId);
    const owned = new Set(memberships.map((membership) => membership.deviceId));
    const online = (await this.onlineDevices(request.accountId)).filter((device) => owned.has(device.deviceId));
    const route = await this.#routingFor(request.accountId).resolve({
      explicitDeviceId: request.explicitDeviceId,
      projectKey: request.projectKey,
      requiredCapabilities: request.requiredCapabilities ?? []
    }, online);
    const delivery = await this.#deliveries.enqueue(route.deviceId, request.kind, request.payload);
    await this.#pump(route.deviceId);
    return { route, delivery };
  }

  async deliveryCursor(deviceId: string): Promise<{ lastAckedSeq: number; highestEnqueuedSeq: number }> {
    return await this.#deliveries.cursor(deviceId);
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
      messageQueue = messageQueue.then(async () => {
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
      void messageQueue.catch(fail);
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
    const fingerprint = String(payload.fingerprint ?? '');
    const resumeAfterSeq = Number(payload.resumeAfterSeq ?? 0);
    if (!Number.isSafeInteger(resumeAfterSeq) || resumeAfterSeq < 0) throw new OperatorError('RELAY_HELLO_INVALID', 'Relay resume cursor is invalid.');
    const sentAt = validIso(String(payload.sentAt ?? ''), 'sentAt');
    if (Math.abs(this.#clock().getTime() - Date.parse(sentAt)) > HELLO_CLOCK_SKEW_MS) throw new OperatorError('RELAY_HELLO_STALE', 'Relay hello timestamp is outside the accepted clock-skew window.');
    validNonce(String(payload.nonce ?? ''));
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

    const reconciled = await this.#deliveries.reconcileClientCursor(deviceId, resumeAfterSeq);
    const sessionId = crypto.randomUUID();
    const now = this.#clock().toISOString();
    const capabilities = session.scopes.filter((scope) => scope.startsWith('cap:')).map((scope) => scope.slice(4)).filter(Boolean).sort();
    const previous = this.#connections.get(deviceId);
    if (previous) {
      try { previous.socket.close(4001, 'connection superseded'); } catch { /* noop */ }
    }
    const connection: Connection = { socket, deviceId, sessionId, capabilities, connectedAt: now, lastSeenAt: now };
    this.#connections.set(deviceId, connection);
    send(socket, {
      type: 'welcome',
      protocol: 1,
      connectionId: sessionId,
      resumeFromSeq: reconciled.lastAckedSeq,
      heartbeatMs: HEARTBEAT_MS
    });
    return connection;
  }

  async #pump(deviceId: string): Promise<void> {
    const connection = this.#connections.get(deviceId);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN || connection.inFlightSeq !== undefined) return;
    const [next] = await this.#deliveries.pending(deviceId, 1);
    if (!next) return;
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
