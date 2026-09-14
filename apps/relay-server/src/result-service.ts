import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { AccountDeviceRegistry } from '../../../src/core/account-device-registry.ts';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { DeviceRegistryStore, type PairingResponse } from '../../../src/core/device-registry.ts';
import { DeviceEnrollmentStore, enrollmentPollBinding } from '../../../src/core/device-enrollment.ts';
import { DeviceResetStore } from '../../../src/core/device-reset.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { applyBoundedHttpServerPolicy } from '../../../src/core/network-authority.ts';
import { FixedWindowRateLimiter, requestClientKey } from '../../../src/core/rate-limit.ts';
import { RelayDeliveryStore } from '../../../src/core/relay-delivery-store.ts';
import { RelayResultStore } from '../../../src/core/relay-result-store.ts';
import { DeviceSessionTokenStore } from '../../../src/core/session-token.ts';
import { PUBLIC_PLUGIN_CAPABILITIES } from '../../../src/core/public-plugin-surface.ts';

const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_GC_INTERVAL_MS = 5 * 60_000;
const DEFAULT_REQUEST_LIMIT_PER_MINUTE = 120;
const DEFAULT_DEVICE_LIMIT_PER_MINUTE = 180;

type JsonObject = Record<string, unknown>;

export interface RelayResultServiceOptions {
  stateDir: string;
  identity?: DeviceIdentityStore;
  devices?: DeviceRegistryStore;
  sessions?: DeviceSessionTokenStore;
  accounts?: AccountDeviceRegistry;
  deliveries?: RelayDeliveryStore;
  results?: RelayResultStore;
  enrollments?: DeviceEnrollmentStore;
  resets?: DeviceResetStore;
  gcIntervalMs?: number;
  requestLimitPerMinute?: number;
  deviceLimitPerMinute?: number;
}

export class RelayResultService {
  #identity: DeviceIdentityStore;
  #devices: DeviceRegistryStore;
  #sessions: DeviceSessionTokenStore;
  #enrollments: DeviceEnrollmentStore;
  #resets: DeviceResetStore;
  #accounts: AccountDeviceRegistry;
  #deliveries: RelayDeliveryStore;
  #results: RelayResultStore;
  #gcIntervalMs: number;
  #gcTimer: NodeJS.Timeout | null = null;
  #gcRun: Promise<void> | null = null;
  #requestLimiter: FixedWindowRateLimiter;
  #deviceLimiter: FixedWindowRateLimiter;
  #server: http.Server | null = null;

  constructor(options: RelayResultServiceOptions) {
    const stateDir = path.resolve(options.stateDir);
    const identity = options.identity ?? new DeviceIdentityStore(stateDir);
    const devices = options.devices ?? new DeviceRegistryStore(stateDir);
    this.#identity = identity;
    this.#devices = devices;
    this.#sessions = options.sessions ?? new DeviceSessionTokenStore(stateDir, identity, devices);
    this.#enrollments = options.enrollments ?? new DeviceEnrollmentStore(stateDir);
    this.#resets = options.resets ?? new DeviceResetStore(stateDir);
    this.#accounts = options.accounts ?? new AccountDeviceRegistry(stateDir, devices);
    this.#deliveries = options.deliveries ?? new RelayDeliveryStore(stateDir);
    this.#results = options.results ?? new RelayResultStore(stateDir);
    const gcIntervalMs = Number(options.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS);
    if (!Number.isFinite(gcIntervalMs) || gcIntervalMs < 10 || gcIntervalMs > 24 * 60 * 60_000) throw new OperatorError('RELAY_RESULT_GC_INTERVAL_INVALID', 'Relay result GC interval is invalid.');
    this.#gcIntervalMs = Math.trunc(gcIntervalMs);
    const requestLimit = boundedPositiveInt(options.requestLimitPerMinute, DEFAULT_REQUEST_LIMIT_PER_MINUTE, 'requestLimitPerMinute');
    const deviceLimit = boundedPositiveInt(options.deviceLimitPerMinute, DEFAULT_DEVICE_LIMIT_PER_MINUTE, 'deviceLimitPerMinute');
    this.#requestLimiter = new FixedWindowRateLimiter({ limit: requestLimit, windowMs: 60_000 });
    this.#deviceLimiter = new FixedWindowRateLimiter({ limit: deviceLimit, windowMs: 60_000 });
  }

  async listen(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
    if (this.#server) throw new OperatorError('RELAY_RESULT_ALREADY_LISTENING', 'Relay result service is already listening.');
    await this.#results.pruneExpired();
    const server = http.createServer(async (request, response) => {
      try {
        if (request.method === 'GET' && request.url === '/health') {
          send(response, 200, { ok: true, service: 'operator-relay-results', version: 1 });
          return;
        }
        const isResultRequest = request.url === '/v1/device-result';
        const isRotateRequest = request.url === '/v1/device-session/rotate';
        const isEnrollmentChallenge = request.url === '/v1/device-enrollment/challenge';
        const isEnrollmentComplete = request.url === '/v1/device-enrollment/complete';
        const isEnrollmentPoll = request.url === '/v1/device-enrollment/poll';
        const isResetRequest = request.url === '/v1/device-self/reset';
        const accepted = isResultRequest || isRotateRequest || isEnrollmentChallenge || isEnrollmentComplete || isEnrollmentPoll || isResetRequest;
        if (request.method !== 'POST' || !accepted) {
          send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });
          return;
        }
        const requestDecision = this.#requestLimiter.hit(requestClientKey(request));
        if (!requestDecision.allowed) {
          send(response, 429, { ok: false, error: { code: 'RELAY_RESULT_RATE_LIMITED', message: 'Relay requests are rate limited.' } }, { 'retry-after': String(requestDecision.retryAfterSeconds) });
          return;
        }
        if (isEnrollmentChallenge) {
          const body = await readJson(request) as { deviceId?: unknown };
          const deviceId = uuid(String(body.deviceId ?? ''), 'deviceId');
          const issuer = await this.#identity.loadOrCreate();
          const challenge = await this.#devices.issuePairingChallenge(issuer, { expectedPeerDeviceId: deviceId });
          send(response, 200, { ok: true, challenge });
          return;
        }
        if (isEnrollmentComplete) {
          const body = await readJson(request) as { pairingResponse?: unknown; pollToken?: unknown; pollSignature?: unknown };
          const pairing = pairingResponse(body.pairingResponse);
          const pollToken = enrollmentPollToken(body.pollToken);
          const pollSignature = enrollmentSignature(body.pollSignature);
          const binding = enrollmentPollBinding(pairing.challengeId, pairing.peer.deviceId, pollToken);
          let pollProofValid = false;
          try { pollProofValid = crypto.verify(null, binding, pairing.peer.publicKeyPem, Buffer.from(pollSignature, 'base64url')); } catch { pollProofValid = false; }
          if (!pollProofValid) throw new OperatorError('DEVICE_ENROLLMENT_SIGNATURE_INVALID', 'Device enrollment poll authority proof is invalid.');
          const peer = await this.#devices.verifyPairingForEnrollment(pairing, { allowExactReplay: true });
          const enrollment = await this.#enrollments.create(peer, { enrollmentId: pairing.challengeId, pollToken });
          send(response, 200, { ok: true, enrollment: { enrollmentId: enrollment.enrollmentId, deviceId: enrollment.deviceId, deviceName: enrollment.deviceName, userCode: enrollment.userCode, expiresAt: enrollment.expiresAt } });
          return;
        }
        if (isEnrollmentPoll) {
          const body = await readJson(request) as { enrollmentId?: unknown; pollToken?: unknown };
          const enrollmentId = uuid(String(body.enrollmentId ?? ''), 'enrollmentId');
          const pollToken = enrollmentPollToken(body.pollToken);
          let enrollment = await this.#enrollments.poll(enrollmentId, pollToken);
          if (enrollment.status === 'pending') {
            send(response, 202, { ok: true, enrollment: { status: 'pending', enrollmentId, expiresAt: enrollment.expiresAt } });
            return;
          }
          if (enrollment.status === 'reserved') {
            const membership = await this.#accounts.bindDevice(enrollment.accountId!, enrollment.deviceId);
            enrollment = await this.#enrollments.markBound(enrollment.enrollmentId, membership.accountId, membership.authorityGeneration);
          }
          const before = await this.#accounts.activeMembershipForDevice(enrollment.deviceId);
          if (!before || before.accountId !== enrollment.accountId || before.authorityGeneration !== enrollment.authorityGeneration) {
            throw new OperatorError('DEVICE_ENROLLMENT_AUTHORITY_REVOKED', 'Device enrollment account authority is no longer active.');
          }
          const issued = await this.#sessions.issueOrRecover({ jti: enrollment.enrollmentId, subjectDeviceId: enrollment.deviceId, audience: 'operator-relay', scopes: enrollmentSessionScopes() });
          const after = await this.#accounts.activeMembershipForDevice(enrollment.deviceId);
          if (!after || after.accountId !== before.accountId || after.authorityGeneration !== before.authorityGeneration) {
            try { await this.#sessions.revoke(issued.payload.jti, 'account authority changed during enrollment'); } catch { /* already purged by authority release */ }
            throw new OperatorError('DEVICE_ENROLLMENT_AUTHORITY_REVOKED', 'Device account authority changed during enrollment session issuance.');
          }
          await this.#enrollments.markIssued(enrollment.enrollmentId, pollToken, issued.payload.jti);
          send(response, 200, { ok: true, enrollment: { status: 'issued', enrollmentId }, session: { token: issued.token, expiresAt: issued.payload.expiresAt, scopes: [...issued.payload.scopes] } });
          return;
        }
        if (isResetRequest) {
          const token = bearer(request.headers.authorization);
          const signed = await this.#sessions.verifyForResetReceipt(token, { audience: 'operator-relay', requiredScopes: ['relay:connect'] });
          const decision = this.#deviceLimiter.hit(`device:${signed.subjectDeviceId}`);
          if (!decision.allowed) {
            send(response, 429, { ok: false, error: { code: 'RELAY_RESULT_RATE_LIMITED', message: 'Relay device quota exceeded.' } }, { 'retry-after': String(decision.retryAfterSeconds) });
            return;
          }
          let reset = await this.#resets.get(signed.jti);
          if (!reset) {
            const active = await this.#sessions.verify(token, { audience: 'operator-relay', requiredScopes: ['relay:connect'], expectedSubjectDeviceId: signed.subjectDeviceId });
            const membership = await this.#accounts.activeMembershipForDevice(active.subjectDeviceId);
            if (!membership) throw new OperatorError('DEVICE_RESET_AUTHORITY_REVOKED', 'Device no longer has active account authority.');
            reset = await this.#resets.begin({ sessionJti: active.jti, deviceId: active.subjectDeviceId, accountId: membership.accountId, authorityGeneration: membership.authorityGeneration });
          } else if (reset.deviceId !== signed.subjectDeviceId) {
            throw new OperatorError('DEVICE_RESET_STATE_MISMATCH', 'Reset receipt does not match this device session.');
          }
          if (reset.phase !== 'COMPLETE') {
            const current = await this.#accounts.activeMembershipForDevice(reset.deviceId);
            if (current) {
              if (current.accountId !== reset.accountId || current.authorityGeneration !== reset.authorityGeneration) throw new OperatorError('DEVICE_RESET_SUPERSEDED', 'A newer device authority superseded this reset request.');
              await this.#accounts.removeDevice(reset.accountId, reset.deviceId, 'local device reset');
            }
            const after = await this.#accounts.activeMembershipForDevice(reset.deviceId);
            if (after) throw new OperatorError('DEVICE_RESET_SUPERSEDED', 'Device authority changed before reset completion.');
            await this.#devices.revokeDevice(reset.deviceId, 'local device reset');
            reset = await this.#resets.complete(reset.sessionJti);
          }
          send(response, 200, { ok: true, reset: { status: 'complete', deviceId: reset.deviceId, completedAt: reset.completedAt } });
          return;
        }
        const token = bearer(request.headers.authorization);
        const session = isRotateRequest
          ? await this.#sessions.verifyForRotation(token, { audience: 'operator-relay', requiredScopes: ['relay:connect'] })
          : await this.#sessions.verify(token, { audience: 'operator-relay', requiredScopes: ['relay:connect', 'relay:result'] });
        const deviceDecision = this.#deviceLimiter.hit(`device:${session.subjectDeviceId}`);
        if (!deviceDecision.allowed) {
          send(response, 429, { ok: false, error: { code: 'RELAY_RESULT_RATE_LIMITED', message: 'Relay device quota exceeded.' } }, { 'retry-after': String(deviceDecision.retryAfterSeconds) });
          return;
        }
        if (isRotateRequest) {
          const before = await this.#accounts.activeMembershipForDevice(session.subjectDeviceId);
          if (!before) throw new OperatorError('SESSION_AUTHORITY_REVOKED', 'Device no longer has active account authority.');
          const rotated = await this.#sessions.rotate(session.jti);
          const after = await this.#accounts.activeMembershipForDevice(session.subjectDeviceId);
          if (!after || after.accountId !== before.accountId || after.authorityGeneration !== before.authorityGeneration) {
            try { await this.#sessions.revoke(rotated.payload.jti, 'account authority changed during rotation'); }
            catch (error) { if (!(error instanceof OperatorError && error.code === 'SESSION_NOT_FOUND')) throw error; }
            throw new OperatorError('SESSION_AUTHORITY_REVOKED', 'Device account authority changed during session rotation.');
          }
          send(response, 200, { ok: true, session: { token: rotated.token, expiresAt: rotated.payload.expiresAt, scopes: [...rotated.payload.scopes] } });
          return;
        }
        const body = await readJson(request) as { seq?: unknown; deliveryId?: unknown; result?: unknown };
        const seq = positiveSeq(body.seq);
        const deliveryId = uuid(String(body.deliveryId ?? ''), 'deliveryId');
        if (!body.result || typeof body.result !== 'object' || Array.isArray(body.result)) throw new OperatorError('RELAY_RESULT_INVALID', 'Result body must be a JSON object.');
        const pending = await this.#deliveries.pending(session.subjectDeviceId, 1);
        let expected = pending[0];
        if (!expected || expected.seq !== seq || expected.id !== deliveryId) {
          const retained = await this.#deliveries.retained(session.subjectDeviceId, seq);
          if (!retained || retained.id !== deliveryId || retained.status !== 'expired' || !retained.idempotencyKey) {
            throw new OperatorError('RELAY_RESULT_DELIVERY_MISMATCH', 'Result does not match the device first pending or retained expired idempotent delivery.');
          }
          expected = retained;
        }
        const stored = await this.#results.put(session.subjectDeviceId, seq, deliveryId, body.result as JsonObject, expected.idempotencyKey);
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
    this.#gcTimer = setInterval(() => {
      if (this.#gcRun) return;
      const run = this.#results.pruneExpired().then(() => undefined, () => undefined);
      this.#gcRun = run;
      void run.finally(() => { if (this.#gcRun === run) this.#gcRun = null; });
    }, this.#gcIntervalMs);
    this.#gcTimer.unref();
    return { host, port: address.port };
  }

  async getResult(deviceId: string, seq: number): Promise<Awaited<ReturnType<RelayResultStore['get']>>> {
    return await this.#results.get(deviceId, seq);
  }

  async close(): Promise<void> {
    if (this.#gcTimer) clearInterval(this.#gcTimer);
    this.#gcTimer = null;
    const gcRun = this.#gcRun;
    this.#gcRun = null;
    if (gcRun) await gcRun;
    const server = this.#server;
    this.#server = null;
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function pairingResponse(input: unknown): PairingResponse {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('DEVICE_ENROLLMENT_INPUT_INVALID', 'Pairing response is required.');
  const raw = input as Record<string, unknown>;
  const challengeId = uuid(String(raw.challengeId ?? ''), 'challengeId');
  if (!raw.peer || typeof raw.peer !== 'object' || Array.isArray(raw.peer)) throw new OperatorError('DEVICE_ENROLLMENT_INPUT_INVALID', 'Pairing peer identity is required.');
  const signature = enrollmentSignature(raw.signature);
  return { challengeId, peer: raw.peer as PairingResponse['peer'], signature };
}

function enrollmentPollToken(input: unknown): string {
  const value = String(input ?? '').trim();
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(value)) throw new OperatorError('DEVICE_ENROLLMENT_UNAUTHORIZED', 'Device enrollment poll authority is invalid.');
  return value;
}

function enrollmentSignature(input: unknown): string {
  const value = String(input ?? '');
  if (!/^[A-Za-z0-9_-]{40,256}$/.test(value)) throw new OperatorError('DEVICE_ENROLLMENT_SIGNATURE_INVALID', 'Device enrollment signature is malformed.');
  return value;
}

function enrollmentSessionScopes(): string[] {
  return ['relay:connect', 'relay:result', ...PUBLIC_PLUGIN_CAPABILITIES.map((capability) => `cap:${capability}`)];
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

function send(response: http.ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders
  });
  response.end(body);
}

function boundedPositiveInt(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 1 || selected > 100_000) {
    throw new OperatorError('RELAY_RESULT_LIMIT_CONFIG_INVALID', `${label} must be an integer between 1 and 100000.`);
  }
  return selected;
}
