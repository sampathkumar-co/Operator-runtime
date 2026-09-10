import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OperatorError } from '../../../src/core/errors.ts';
import { applyBoundedHttpServerPolicy } from '../../../src/core/network-authority.ts';
import type { RelayHub } from './relay-hub.ts';
import type { RelayResultStore } from '../../../src/core/relay-result-store.ts';
import type { ActionRequest, ActionResult } from '../../../src/core/types.ts';

const MAX_BODY_BYTES = 512 * 1024;
const DEFAULT_WAIT_MS = 10 * 60_000;
const MAX_WAIT_MS = 10 * 60_000;

export class RelayControlService {
  #hub: RelayHub;
  #results: RelayResultStore;
  #token: string;
  #server: http.Server | null = null;

  constructor(options: { hub: RelayHub; results: RelayResultStore; token: string }) {
    if (options.token.length < 32) throw new Error('Relay control token must be at least 32 characters.');
    this.#hub = options.hub;
    this.#results = options.results;
    this.#token = options.token;
  }

  async listen(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
    if (!isLoopback(host)) throw new Error('Relay control service is internal-only and must bind to loopback.');
    if (this.#server) throw new Error('Relay control service is already listening.');
    const server = http.createServer(async (request, response) => {
      const startedAt = performance.now();
      try {
        if (request.method === 'GET' && request.url === '/health') {
          send(response, 200, { ok: true, service: 'operator-relay-control', version: 1 });
          return;
        }
        if (request.method !== 'POST' || request.url !== '/v1/execute') {
          send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });
          return;
        }
        if (!bearerMatches(request.headers.authorization, this.#token)) {
          send(response, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Valid relay control bearer token required.' } });
          return;
        }
        const body = await readJson(request) as {
          accountId?: unknown;
          deviceId?: unknown;
          projectKey?: unknown;
          action?: unknown;
          waitMs?: unknown;
        };
        const accountId = validUuid(String(body.accountId ?? ''), 'accountId');
        const deviceId = body.deviceId === undefined ? undefined : validUuid(String(body.deviceId), 'deviceId');
        const projectKey = body.projectKey === undefined ? undefined : validProjectKey(String(body.projectKey));
        const action = validAction(body.action);
        const waitMs = body.waitMs === undefined ? DEFAULT_WAIT_MS : boundedWait(body.waitMs);

        const dispatched = await this.#hub.dispatch({
          accountId,
          explicitDeviceId: deviceId,
          projectKey,
          requiredCapabilities: [action.capability],
          kind: 'action',
          payload: { action }
        });
        const deadline = Date.now() + waitMs;
        while (Date.now() <= deadline) {
          const stored = await this.#results.get(dispatched.route.deviceId, dispatched.delivery.seq);
          if (stored && stored.deliveryId === dispatched.delivery.id) {
            const result = stored.result as unknown as ActionResult;
            if (!isActionResult(result, action.capability)) {
              return send(response, 502, relayFailure(action.capability, startedAt, 'RELAY_RESULT_INVALID', 'Device returned a malformed ActionResult.', dispatched.route.deviceId, dispatched.delivery.seq));
            }
            send(response, 200, result);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        send(response, 504, relayFailure(
          action.capability,
          startedAt,
          'RELAY_RESULT_PENDING',
          'The routed action has no durable result yet. Do not blindly repeat the action; reconcile the delivery first.',
          dispatched.route.deviceId,
          dispatched.delivery.seq
        ));
      } catch (error) {
        const op = error instanceof OperatorError ? error : new OperatorError('RELAY_CONTROL_FAILED', error instanceof Error ? error.message : String(error));
        const status = op.code === 'REQUEST_TOO_LARGE' ? 413 : op.code === 'UNAUTHORIZED' ? 401 : 409;
        send(response, status, relayFailure('relay.execute', startedAt, op.code, op.message));
      }
    });
    applyBoundedHttpServerPolicy(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    this.#server = server;
    const address = server.address() as AddressInfo;
    return { host, port: address.port };
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function relayFailure(capability: string, startedAt: number, code: string, message: string, deviceId?: string, seq?: number): ActionResult {
  return {
    ok: false,
    capability,
    provider: 'relay.control',
    evidence: [{
      kind: 'relay',
      status: 'fail',
      message,
      data: { code, ...(deviceId ? { deviceId } : {}), ...(seq ? { deliverySeq: seq } : {}) },
      timestamp: new Date().toISOString()
    }],
    error: { code, message, retryable: false },
    durationMs: Math.round(performance.now() - startedAt)
  };
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new OperatorError('REQUEST_TOO_LARGE', 'Relay control request exceeds the maximum body size.');
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Relay control request body is required.');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Relay control request must contain valid JSON.'); }
}

function validAction(input: unknown): ActionRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'action is required.');
  const raw = input as Record<string, unknown>;
  const id = validName(String(raw.id ?? ''), 'action id');
  const capability = validName(String(raw.capability ?? ''), 'capability');
  const risk = String(raw.risk ?? '');
  if (!['read', 'write', 'external', 'system', 'destructive'].includes(risk)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Action risk is invalid.');
  if (!raw.input || typeof raw.input !== 'object' || Array.isArray(raw.input)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Action input must be an object.');
  const inputText = JSON.stringify(raw.input);
  if (Buffer.byteLength(inputText, 'utf8') > 256 * 1024) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Action input exceeds the bounded size.');
  if (!raw.provenance || typeof raw.provenance !== 'object' || Array.isArray(raw.provenance) || (raw.provenance as any).kind !== 'chatgpt') {
    throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Relay control accepts only ChatGPT-provenance actions.');
  }
  const target = raw.target === undefined ? undefined : boundedText(String(raw.target), 2048, 'target');
  const taskId = raw.taskId === undefined ? undefined : validName(String(raw.taskId), 'taskId');
  return {
    id,
    capability,
    risk: risk as ActionRequest['risk'],
    input: structuredClone(raw.input as Record<string, unknown>),
    provenance: { kind: 'chatgpt' },
    target,
    taskId
  };
}

function isActionResult(input: ActionResult, capability: string): boolean {
  return Boolean(input && typeof input === 'object' && typeof input.ok === 'boolean' && input.capability === capability && typeof input.provider === 'string' && Array.isArray(input.evidence) && Number.isFinite(input.durationMs));
}

function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function boundedWait(input: unknown): number {
  const value = Number(input);
  if (!Number.isInteger(value) || value < 1_000 || value > MAX_WAIT_MS) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', `waitMs must be between 1000 and ${MAX_WAIT_MS}.`);
  return value;
}

function validUuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', `${label} must be a UUID.`);
  return value.toLowerCase();
}

function validProjectKey(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'projectKey is invalid.');
  return value;
}

function validName(value: string, label: string): string {
  if (!value || value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', `${label} is invalid.`);
  return value;
}

function boundedText(value: string, max: number, label: string): string {
  if (!value || Buffer.byteLength(value, 'utf8') > max) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', `${label} is invalid.`);
  return value;
}

function isLoopback(input: string): boolean {
  const host = input.toLowerCase().replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
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
