import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { answerPairingChallenge, type PublicPairingChallenge } from '../../../src/core/device-registry.ts';
import { enrollmentPollBinding } from '../../../src/core/device-enrollment.ts';
import { OperatorError } from '../../../src/core/errors.ts';

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_MS = 2_000;

type EnrollmentCodeNotice = { userCode: string; expiresAt: string };

export interface RelayEnrollmentClientOptions {
  relayUrl: string;
  resultUrl?: string;
  identity: DeviceIdentityStore;
  allowLoopbackInsecure?: boolean;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  onUserCode?: (notice: EnrollmentCodeNotice) => void | Promise<void>;
}

export class RelayEnrollmentClient {
  #identity: DeviceIdentityStore;
  #base: URL;
  #fetch: typeof fetch;
  #pollIntervalMs: number;
  #onUserCode?: (notice: EnrollmentCodeNotice) => void | Promise<void>;
  #abort = new AbortController();

  constructor(options: RelayEnrollmentClientOptions) {
    this.#identity = options.identity;
    this.#base = validateEnrollmentAuthority(options.relayUrl, options.resultUrl, Boolean(options.allowLoopbackInsecure));
    this.#fetch = options.fetchImpl ?? fetch;
    const pollMs = Number(options.pollIntervalMs ?? DEFAULT_POLL_MS);
    if (!Number.isInteger(pollMs) || pollMs < 100 || pollMs > 30_000) {
      throw new OperatorError('DEVICE_ENROLLMENT_POLL_CONFIG_INVALID', 'Device enrollment poll interval is invalid.');
    }
    this.#pollIntervalMs = pollMs;
    this.#onUserCode = options.onUserCode;
  }

  stop(): void { this.#abort.abort(); }

  async enroll(): Promise<string> {
    if (this.#abort.signal.aborted) throw new OperatorError('DEVICE_ENROLLMENT_STOPPED', 'Device enrollment was stopped.');
    const device = await this.#identity.loadOrCreate();
    const challenged = await this.#post('/v1/device-enrollment/challenge', { deviceId: device.deviceId });
    if (challenged.status !== 200) throw enrollmentHttpError(challenged.status, challenged.body);
    const challenge = challenged.body?.challenge as PublicPairingChallenge;
    const pairing = await answerPairingChallenge(challenge, this.#identity);
    const pollToken = crypto.randomBytes(32).toString('base64url');
    const pollSignature = await this.#identity.sign(enrollmentPollBinding(pairing.challengeId, device.deviceId, pollToken));
    const completed = await this.#post('/v1/device-enrollment/complete', { pairingResponse: pairing, pollToken, pollSignature });
    if (completed.status !== 200) throw enrollmentHttpError(completed.status, completed.body);
    const enrollmentId = validUuid(String(completed.body?.enrollment?.enrollmentId ?? ''), 'enrollmentId');
    if (enrollmentId !== pairing.challengeId) throw new OperatorError('DEVICE_ENROLLMENT_STATE_MISMATCH', 'Relay enrollment identity changed unexpectedly.');
    const userCode = validUserCode(String(completed.body?.enrollment?.userCode ?? ''));
    const expiresAt = validIso(String(completed.body?.enrollment?.expiresAt ?? ''), 'enrollment expiry');
    await this.#onUserCode?.({ userCode, expiresAt });

    while (Date.now() < Date.parse(expiresAt)) {
      const polled = await this.#post('/v1/device-enrollment/poll', { enrollmentId, pollToken });
      if (polled.status === 202) {
        await delay(this.#pollIntervalMs, undefined, { signal: this.#abort.signal });
        continue;
      }
      if (polled.status !== 200) throw enrollmentHttpError(polled.status, polled.body);
      const token = String(polled.body?.session?.token ?? '');
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || Buffer.byteLength(token, 'utf8') > 16 * 1024) {
        throw new OperatorError('DEVICE_ENROLLMENT_SESSION_INVALID', 'Relay enrollment returned an invalid session credential.');
      }
      return token;
    }
    throw new OperatorError('DEVICE_ENROLLMENT_EXPIRED', 'Device enrollment expired before account claim completed.');
  }
  async #post(pathname: string, payload: unknown): Promise<{ status: number; body: any }> {
    const url = new URL(pathname, this.#base);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        redirect: 'error',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      });
    } catch (error) {
      if (this.#abort.signal.aborted) throw new OperatorError('DEVICE_ENROLLMENT_STOPPED', 'Device enrollment was stopped.');
      throw new OperatorError('DEVICE_ENROLLMENT_REQUEST_FAILED', `Device enrollment request failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true });
    }
    let body: any = null;
    try { body = await response.json(); } catch { /* handled below */ }
    return { status: response.status, body };
  }
}

function enrollmentHttpError(status: number, body: any): OperatorError {
  const code = typeof body?.error?.code === 'string' ? body.error.code : 'DEVICE_ENROLLMENT_REQUEST_FAILED';
  const retryable = status === 408 || status === 429 || status >= 500;
  return new OperatorError(code, `Device enrollment service returned HTTP ${status}.`, { retryable });
}
function validateEnrollmentAuthority(relayInput: string, resultInput: string | undefined, allowLoopbackInsecure: boolean): URL {
  let relay: URL;
  try { relay = new URL(relayInput); } catch { throw new OperatorError('RELAY_URL_INVALID', 'Relay URL is invalid.'); }
  if (relay.username || relay.password || relay.search || relay.hash || !['ws:', 'wss:'].includes(relay.protocol)) {
    throw new OperatorError('RELAY_URL_INVALID', 'Relay URL authority is invalid.');
  }
  const expected = new URL(relay.toString());
  expected.protocol = relay.protocol === 'wss:' ? 'https:' : 'http:';
  expected.pathname = '/'; expected.search = ''; expected.hash = '';
  if (!resultInput) {
    if (expected.protocol === 'https:' || (allowLoopbackInsecure && isLoopback(expected.hostname))) return expected;
    throw new OperatorError('DEVICE_ENROLLMENT_TLS_REQUIRED', 'Device enrollment requires HTTPS except for explicit loopback development.');
  }
  let result: URL;
  try { result = new URL(resultInput); } catch { throw new OperatorError('RELAY_RESULT_URL_INVALID', 'Relay result URL is invalid.'); }
  if (result.username || result.password || result.search || result.hash || result.pathname !== '/v1/device-result') {
    throw new OperatorError('RELAY_RESULT_URL_INVALID', 'Relay result URL authority is invalid.');
  }
  const loopback = allowLoopbackInsecure && isLoopback(relay.hostname) && isLoopback(result.hostname);
  if (!loopback && (result.protocol !== 'https:' || expected.protocol !== 'https:' || result.origin !== expected.origin)) {
    throw new OperatorError('DEVICE_ENROLLMENT_AUTHORITY_MISMATCH', 'Device enrollment must use the relay-authorized HTTPS origin.');
  }
  result.pathname = '/'; return result;
}

function validUuid(input: string, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new OperatorError('DEVICE_ENROLLMENT_INPUT_INVALID', `${label} must be a UUID.`);
  }
  return value;
}

function validUserCode(input: string): string {
  const compact = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(compact)) {
    throw new OperatorError('DEVICE_ENROLLMENT_CODE_INVALID', 'Relay enrollment returned an invalid pairing code.');
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function validIso(input: string, label: string): string {
  const value = String(input ?? '');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new OperatorError('DEVICE_ENROLLMENT_INPUT_INVALID', `${label} must be an ISO timestamp.`);
  }
  return value;
}

function isLoopback(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}
