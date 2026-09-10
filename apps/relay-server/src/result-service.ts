import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { DeviceRegistryStore } from '../../../src/core/device-registry.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { applyBoundedHttpServerPolicy } from '../../../src/core/network-authority.ts';
import { RelayDeliveryStore } from '../../../src/core/relay-delivery-store.ts';
import { RelayResultStore } from '../../../src/core/relay-result-store.ts';
import { DeviceSessionTokenStore } from '../../../src/core/session-token.ts';

const MAX_BODY_BYTES = 256 * 1024;

type JsonObject = Record<string, unknown>;

export interface RelayResultServiceOptions {
  stateDir: string;
  identity?: DeviceIdentityStore;
  devices?: DeviceRegistryStore;
  sessions?: DeviceSessionTokenStore;
  deliveries?: RelayDeliveryStore;
  results?: RelayResultStore;
}

export class RelayResultService {
  #sessions: DeviceSessionTokenStore;
  #deliveries: RelayDeliveryStore;
  #results: RelayResultStore;
  #server: http.Server | null = null;

  constructor(options: RelayResultServiceOptions) {
    const stateDir = path.resolve(options.stateDir);
    const identity = options.identity ?? new DeviceIdentityStore(stateDir);
    const devices = options.devices ?? new DeviceRegistryStore(stateDir);
    this.#sessions = options.sessions ?? new DeviceSessionTokenStore(stateDir, identity, devices);
    this.#deliveries = options.deliveries ?? new RelayDeliveryStore(stateDir);
    this.#results = options.results ?? new RelayResultStore(stateDir);
  }

  async listen(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
    if (this.#server) throw new OperatorError('RELAY_RESULT_ALREADY_LISTENING', 'Relay result service is already listening.');
    const server = http.createServer(async (request, response) => {
      try {
        if (request.method === 'GET' && request.url === '/health') {
          send(response, 200, { ok: true, service: 'operator-relay-results', version: 1 });
          return;
        }
        if (request.method !== 'POST' || request.url !== '/v1/device-result') {
          send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });
          return;
        }
        const token = bearer(request.headers.authorization);
        const session = await this.#sessions.verify(token, {
          audience: 'operator-relay',
          requiredScopes: ['relay:connect', 'relay:result']
        });
        const body = await readJson(request) as { seq?: unknown; deliveryId?: unknown; result?: unknown };
        const seq = positiveSeq(body.seq);
        const deliveryId = uuid(String(body.deliveryId ?? ''), 'deliveryId');
        if (!body.result || typeof body.result !== 'object' || Array.isArray(body.result)) throw new OperatorError('RELAY_RESULT_INVALID', 'Result body must be a JSON object.');
        const pending = await this.#deliveries.pending(session.subjectDeviceId, 1);
        const expected = pending[0];
        if (!expected || expected.seq !== seq || expected.id !== deliveryId) {
          throw new OperatorError('RELAY_RESULT_DELIVERY_MISMATCH', 'Result does not match the device first pending delivery.');
        }
        const stored = await this.#results.put(session.subjectDeviceId, seq, deliveryId, body.result as JsonObject);
        send(response, 200, {
          ok: true,
          accepted: { deviceId: session.subjectDeviceId, seq, deliveryId, duplicate: stored.duplicate, resultSha256: stored.result.resultSha256 }
        });
      } catch (error) {
        const op = error instanceof OperatorError ? error : new OperatorError('RELAY_RESULT_REQUEST_FAILED', error instanceof Error ? error.message : String(error));
        const status = op.code === 'RELAY_RESULT_UNAUTHORIZED' || op.code.startsWith('SESSION_') ? 401
          : op.code === 'REQUEST_TOO_LARGE' ? 413
          : op.code === 'RELAY_RESULT_CONFLICT' ? 409
          : 400;
        send(response, status, { ok: false, error: { code: op.code, message: op.message } });
      }
    });
    applyBoundedHttpServerPolicy(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    const address = server.address() as AddressInfo;
    this.#server = server;
    return { host, port: address.port };
  }

  async getResult(deviceId: string, seq: number): Promise<Awaited<ReturnType<RelayResultStore['get']>>> {
    return await this.#results.get(deviceId, seq);
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new OperatorError('REQUEST_TOO_LARGE', 'Relay result request exceeds the maximum body size.');
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new OperatorError('RELAY_RESULT_INVALID', 'Relay result request body is required.');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new OperatorError('RELAY_RESULT_INVALID', 'Relay result request body must be valid JSON.'); }
}

function bearer(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) throw new OperatorError('RELAY_RESULT_UNAUTHORIZED', 'Valid relay session bearer token required.');
  const token = header.slice('Bearer '.length);
  if (!token || Buffer.byteLength(token, 'utf8') > 16 * 1024) throw new OperatorError('RELAY_RESULT_UNAUTHORIZED', 'Relay session token is invalid.');
  return token;
}

function positiveSeq(input: unknown): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < 1) throw new OperatorError('RELAY_RESULT_SEQUENCE_INVALID', 'Result sequence must be a positive safe integer.');
  return value;
}

function uuid(input: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)) throw new OperatorError('RELAY_RESULT_ID_INVALID', `${label} must be a UUID.`);
  return input.toLowerCase();
}

function send(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(body);
}
