import fs from 'node:fs/promises';
import path from 'node:path';
import type { DeviceSecretProtector } from '../../../src/core/device-identity.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { readDurableStateText, writeDurableStateText } from '../../../src/core/durable-state.ts';

const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_STATE_BYTES = 128 * 1024;
const DEFAULT_REFRESH_SKEW_MS = 60_000;
const RETRY_REFRESH_MS = 10_000;
const MIN_REMAINING_MS = 5_000;

const LEGACY_TOKEN_OPTIONS = {
  maxBytes: MAX_TOKEN_BYTES,
  errorCode: 'RELAY_SESSION_TOKEN_FILE_INVALID',
  invalidMessage: 'Relay session token file is invalid.'
} as const;

type StoredCredential = {
  version: 1;
  expiresAt: string;
  protection: {
    scheme: 'windows-dpapi-current-user';
    ciphertextBase64: string;
  };
};

export interface RelayEnrollmentProvider {
  enroll(): Promise<string>;
  stop(): void;
}

export interface RelaySessionCredentialProvider {
  forConnection(): Promise<string>;
  forRequest(): Promise<string>;
  stop(): void;
}

export interface RelaySessionCredentialManagerOptions {
  stateDir: string;
  legacyTokenFile: string;
  rotateUrl: string;
  protector: DeviceSecretProtector;
  allowLoopbackInsecure?: boolean;
  refreshSkewMs?: number;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
  enrollment?: RelayEnrollmentProvider;
}

type TokenMetadata = {
  jti: string;
  expiresAt: string;
  expiresAtMs: number;
};

type LoadedCredential = {
  token: string;
  metadata: TokenMetadata;
};

export class RelaySessionCredentialManager implements RelaySessionCredentialProvider {
  #stateFile: string;
  #legacyTokenFile: string;
  #rotateUrl: string;
  #protector: DeviceSecretProtector;
  #refreshSkewMs: number;
  #fetch: typeof fetch;
  #clock: () => Date;
  #enrollment?: RelayEnrollmentProvider;
  #timer: NodeJS.Timeout | null = null;
  #queue: Promise<void> = Promise.resolve();
  #stopped = false;

  constructor(options: RelaySessionCredentialManagerOptions) {
    this.#stateFile = path.join(path.resolve(options.stateDir), 'relay-session-credential.json');
    this.#legacyTokenFile = path.resolve(options.legacyTokenFile);
    this.#rotateUrl = validateRotateUrl(options.rotateUrl, Boolean(options.allowLoopbackInsecure));
    this.#protector = options.protector;
    if (this.#protector.scheme !== 'windows-dpapi-current-user') {
      throw new OperatorError('RELAY_SESSION_PROTECTOR_INVALID', 'Relay session credentials require the Windows DPAPI CurrentUser protector.');
    }
    const refreshSkewMs = Number(options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS);
    if (!Number.isInteger(refreshSkewMs) || refreshSkewMs < 5_000 || refreshSkewMs > 5 * 60_000) {
      throw new OperatorError('RELAY_SESSION_REFRESH_CONFIG_INVALID', 'Relay session refresh skew is invalid.');
    }
    this.#refreshSkewMs = refreshSkewMs;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#clock = options.clock ?? (() => new Date());
    this.#enrollment = options.enrollment;
  }

  async forConnection(): Promise<string> { return await this.#freshToken(); }
  async forReset(): Promise<string> {
    const token = await this.#exclusive(async () => {
      let current = await this.#loadOrMigrate(true);
      if (current.metadata.expiresAtMs <= this.#clock().getTime()) current = await this.#enrollAndPersist();
      return current.token;
    });
    this.stop();
    return token;
  }
  async forRequest(): Promise<string> {
    return await this.#exclusive(async () => {
      const current = await this.#loadOrMigrate(false);
      const now = this.#clock().getTime();
      if (current.metadata.expiresAtMs <= now) {
        throw new OperatorError('RELAY_SESSION_REENROLL_REQUIRED', 'Relay session expired before the result could be submitted.', { retryable: false });
      }
      this.#schedule(current.metadata.expiresAtMs);
      return current.token;
    });
  }

  stop(): void {
    this.#stopped = true;
    this.#enrollment?.stop();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #freshToken(): Promise<string> {
    return await this.#exclusive(async () => {
      let current = await this.#loadOrMigrate(true);
      const now = this.#clock().getTime();
      if (current.metadata.expiresAtMs <= now) {
        if (!this.#enrollment) throw new OperatorError('RELAY_SESSION_REENROLL_REQUIRED', 'Relay session expired before it could be refreshed.', { retryable: false });
        current = await this.#enrollAndPersist();
      }
      if (current.metadata.expiresAtMs - now <= this.#refreshSkewMs) {
        try {
          current = await this.#rotate(current);
        } catch (error) {
          if (error instanceof OperatorError && error.code === 'RELAY_SESSION_REENROLL_REQUIRED' && this.#enrollment) {
            current = await this.#enrollAndPersist();
            this.#schedule(current.metadata.expiresAtMs);
            return current.token;
          }
          const remaining = current.metadata.expiresAtMs - this.#clock().getTime();
          if (!(error instanceof OperatorError) || !error.retryable || remaining <= MIN_REMAINING_MS) throw error;
          this.#scheduleRetry(current.metadata.expiresAtMs);
          return current.token;
        }
      }
      this.#schedule(current.metadata.expiresAtMs);
      return current.token;
    });
  }

  async #loadOrMigrate(allowEnrollment: boolean): Promise<LoadedCredential> {
    try { return await this.#loadProtected(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let token: string;
    try { token = await readRelaySessionTokenFile(this.#legacyTokenFile); }
    catch (error) {
      if (allowEnrollment && this.#enrollment && error instanceof OperatorError && error.code === 'RELAY_SESSION_TOKEN_FILE_MISSING') {
        return await this.#enrollAndPersist();
      }
      throw error;
    }
    const metadata = parseTokenMetadata(token);
    await this.#persist(token, metadata);
    await fs.rm(this.#legacyTokenFile, { force: true });
    return { token, metadata };
  }

  async #enrollAndPersist(): Promise<LoadedCredential> {
    if (!this.#enrollment) throw new OperatorError('RELAY_SESSION_REENROLL_REQUIRED', 'Relay session requires device enrollment.', { retryable: false });
    const token = validateTokenText(await this.#enrollment.enroll());
    const metadata = parseTokenMetadata(token);
    if (metadata.expiresAtMs <= this.#clock().getTime()) throw new OperatorError('DEVICE_ENROLLMENT_SESSION_INVALID', 'Device enrollment returned an expired session credential.');
    await this.#persist(token, metadata);
    return { token, metadata };
  }

  async #loadProtected(): Promise<LoadedCredential> {
    const text = await readDurableStateText(this.#stateFile, {
      maxBytes: MAX_STATE_BYTES,
      errorCode: 'RELAY_SESSION_CREDENTIAL_INVALID',
      invalidMessage: 'Protected relay session credential state is invalid.'
    });
    let stored: StoredCredential;
    try { stored = validateStoredCredential(JSON.parse(text)); }
    catch (error) {
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('RELAY_SESSION_CREDENTIAL_INVALID', 'Protected relay session credential state could not be parsed.');
    }
    const ciphertext = decodeCiphertext(stored.protection.ciphertextBase64);
    let plaintext: Buffer | undefined;
    try {
      plaintext = await this.#protector.unprotect(ciphertext);
      const token = validateTokenText(plaintext.toString('utf8'));
      const metadata = parseTokenMetadata(token);
      if (metadata.expiresAt !== stored.expiresAt) throw new OperatorError('RELAY_SESSION_CREDENTIAL_INVALID', 'Protected relay session expiry metadata does not match its token.');
      return { token, metadata };
    } finally {
      ciphertext.fill(0);
      plaintext?.fill(0);
    }
  }
  async #rotate(current: LoadedCredential): Promise<LoadedCredential> {
    let response: Response;
    try {
      response = await this.#fetch(this.#rotateUrl, {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: `Bearer ${current.token}` },
        signal: AbortSignal.timeout(15_000)
      });
    } catch (error) {
      throw new OperatorError('RELAY_SESSION_REFRESH_FAILED', `Relay session refresh request failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true });
    }
    let body: any = null;
    try { body = await response.json(); } catch { /* safe generic handling below */ }
    if (response.status !== 200) {
      const code = String(body?.error?.code ?? 'RELAY_SESSION_REFRESH_FAILED');
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (response.status === 401) throw new OperatorError('RELAY_SESSION_REENROLL_REQUIRED', 'Relay session authority is no longer refreshable.', { retryable: false });
      throw new OperatorError(code, `Relay session refresh failed with HTTP ${response.status}.`, { retryable });
    }
    const token = validateTokenText(body?.session?.token);
    const metadata = parseTokenMetadata(token);
    if (token === current.token || metadata.jti === current.metadata.jti || metadata.expiresAtMs <= this.#clock().getTime()) {
      throw new OperatorError('RELAY_SESSION_REFRESH_INVALID', 'Relay returned an invalid replacement session.', { retryable: false });
    }
    await this.#persist(token, metadata);
    return { token, metadata };
  }

  async #persist(token: string, metadata: TokenMetadata): Promise<void> {
    const plaintext = Buffer.from(token, 'utf8');
    let ciphertext: Buffer | undefined;
    try {
      ciphertext = await this.#protector.protect(plaintext);
      const stored: StoredCredential = {
        version: 1,
        expiresAt: metadata.expiresAt,
        protection: {
          scheme: 'windows-dpapi-current-user',
          ciphertextBase64: ciphertext.toString('base64')
        }
      };
      await writeDurableStateText(this.#stateFile, JSON.stringify(stored, null, 2), {
        maxBytes: MAX_STATE_BYTES,
        errorCode: 'RELAY_SESSION_CREDENTIAL_INVALID',
        invalidMessage: 'Protected relay session credential state is invalid.'
      });
    } finally {
      plaintext.fill(0);
      ciphertext?.fill(0);
    }
  }

  #schedule(expiresAtMs: number): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    const delay = Math.max(1_000, expiresAtMs - this.#clock().getTime() - this.#refreshSkewMs);
    this.#timer = setTimeout(() => { void this.#refreshFromTimer(); }, delay);
    this.#timer.unref();
  }

  #scheduleRetry(expiresAtMs: number): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    const remaining = expiresAtMs - this.#clock().getTime() - MIN_REMAINING_MS;
    if (remaining <= 0) return;
    const delay = Math.max(1_000, Math.min(RETRY_REFRESH_MS, remaining));
    this.#timer = setTimeout(() => { void this.#refreshFromTimer(); }, delay);
    this.#timer.unref();
  }

  async #refreshFromTimer(): Promise<void> {
    try { await this.#freshToken(); }
    catch { /* a foreground reconnect/request will surface a terminal refresh failure */ }
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.#queue;
    this.#queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }
}

export async function readRelaySessionTokenFile(fileInput: string): Promise<string> {
  const file = path.resolve(fileInput);
  let raw: string;
  try { raw = await readDurableStateText(file, LEGACY_TOKEN_OPTIONS); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new OperatorError('RELAY_SESSION_TOKEN_FILE_MISSING', 'Relay session token file is missing.', { retryable: true });
    }
    if (error instanceof OperatorError) throw error;    throw new OperatorError('RELAY_SESSION_TOKEN_FILE_INVALID', 'Relay session token file could not be read.', {
      retryable: false,
      details: { cause: String(error) }
    });
  }
  return validateTokenText(raw.trim());
}

function validateStoredCredential(input: unknown): StoredCredential {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OperatorError('RELAY_SESSION_CREDENTIAL_INVALID', 'Protected relay session credential state is invalid.');
  }
  const raw = input as Record<string, unknown>;
  if (raw.version !== 1 || !raw.protection || typeof raw.protection !== 'object' || Array.isArray(raw.protection)) {
    throw new OperatorError('RELAY_SESSION_CREDENTIAL_INVALID', 'Protected relay session credential state is invalid.');
  }
  const protection = raw.protection as Record<string, unknown>;
  if (protection.scheme !== 'windows-dpapi-current-user') {
    throw new OperatorError('RELAY_SESSION_CREDENTIAL_INVALID', 'Protected relay session credential scheme is invalid.');
  }
  const expiresAt = validIso(String(raw.expiresAt ?? ''), 'credential expiry');
  const ciphertextBase64 = String(protection.ciphertextBase64 ?? '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertextBase64) || ciphertextBase64.length > MAX_STATE_BYTES) {
    throw new OperatorError('RELAY_SESSION_CREDENTIAL_INVALID', 'Protected relay session credential ciphertext is invalid.');
  }
  return { version: 1, expiresAt, protection: { scheme: 'windows-dpapi-current-user', ciphertextBase64 } };
}
function decodeCiphertext(value: string): Buffer {
  let decoded: Buffer;
  try { decoded = Buffer.from(value, 'base64'); }
  catch { throw new OperatorError('RELAY_SESSION_CREDENTIAL_INVALID', 'Protected relay session credential ciphertext is invalid.'); }
  if (decoded.length < 1 || decoded.length > MAX_STATE_BYTES) {
    decoded.fill(0);
    throw new OperatorError('RELAY_SESSION_CREDENTIAL_INVALID', 'Protected relay session credential ciphertext is invalid.');
  }
  return decoded;
}

function validateTokenText(input: unknown): string {
  const token = String(input ?? '').trim();
  const bytes = Buffer.byteLength(token, 'utf8');
  if (bytes < 16 || bytes > MAX_TOKEN_BYTES || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new OperatorError('RELAY_SESSION_TOKEN_INVALID', 'Relay session credential is invalid.', { retryable: true });
  }
  return token;
}

function parseTokenMetadata(tokenInput: string): TokenMetadata {
  const token = validateTokenText(tokenInput);
  const payloadPart = token.split('.', 1)[0]!;
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')); }
  catch { throw new OperatorError('RELAY_SESSION_TOKEN_INVALID', 'Relay session credential payload is invalid.', { retryable: true }); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new OperatorError('RELAY_SESSION_TOKEN_INVALID', 'Relay session credential payload is invalid.', { retryable: true });
  }
  const raw = payload as Record<string, unknown>;
  const jti = String(raw.jti ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(jti)) {
    throw new OperatorError('RELAY_SESSION_TOKEN_INVALID', 'Relay session credential JTI is invalid.', { retryable: true });
  }
  const expiresAt = validIso(String(raw.expiresAt ?? ''), 'token expiry');
  const expiresAtMs = Date.parse(expiresAt);
  const issuedAt = validIso(String(raw.issuedAt ?? ''), 'token issue time');
  const issuedAtMs = Date.parse(issuedAt);
  if (expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > 15 * 60_000) {
    throw new OperatorError('RELAY_SESSION_TOKEN_INVALID', 'Relay session credential lifetime is invalid.', { retryable: true });
  }
  return { jti, expiresAt, expiresAtMs };
}

function validIso(value: string, label: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new OperatorError('RELAY_SESSION_CREDENTIAL_INVALID', `Relay session ${label} is invalid.`);
  }
  return value;
}

function validateRotateUrl(input: string, allowLoopbackInsecure: boolean): string {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new OperatorError('RELAY_SESSION_ROTATE_URL_INVALID', 'Relay session rotation URL is invalid.'); }
  if (url.username || url.password || url.hash || url.search || url.pathname !== '/v1/device-session/rotate') {
    throw new OperatorError('RELAY_SESSION_ROTATE_URL_INVALID', 'Relay session rotation URL must use the fixed credential-free endpoint.');
  }
  if (url.protocol === 'https:') return url.toString();
  if (url.protocol === 'http:' && allowLoopbackInsecure && isLoopback(url.hostname)) return url.toString();
  throw new OperatorError('RELAY_SESSION_ROTATE_TLS_REQUIRED', 'Relay session rotation requires HTTPS except for explicit loopback development.');
}

function isLoopback(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}

export function deriveRelaySessionRotateUrl(relayUrlInput: string, resultUrlInput?: string, allowLoopbackInsecure = false): string {
  let relay: URL;
  try { relay = new URL(relayUrlInput); }
  catch { throw new OperatorError('RELAY_URL_INVALID', 'Relay URL is invalid.'); }
  if (relay.username || relay.password || relay.hash || relay.search || !['ws:', 'wss:'].includes(relay.protocol)) {
    throw new OperatorError('RELAY_URL_INVALID', 'Relay URL must be credential-free ws:// or wss://.');
  }
  const expected = new URL(relay.toString());
  expected.protocol = relay.protocol === 'wss:' ? 'https:' : 'http:';
  if (resultUrlInput) {
    let result: URL;
    try { result = new URL(resultUrlInput); }
    catch { throw new OperatorError('RELAY_RESULT_URL_INVALID', 'Relay result URL is invalid.'); }
    if (result.username || result.password || result.hash || result.search || result.pathname !== '/v1/device-result') {
      throw new OperatorError('RELAY_RESULT_URL_INVALID', 'Relay result URL authority is invalid.');
    }
    const loopback = allowLoopbackInsecure && isLoopback(relay.hostname) && isLoopback(result.hostname);
    if (!loopback && (result.protocol !== 'https:' || expected.protocol !== 'https:' || result.origin !== expected.origin)) {
      throw new OperatorError('RELAY_RESULT_AUTHORITY_MISMATCH', 'Relay session rotation must stay on the relay-authorized HTTPS origin.');
    }
    result.pathname = '/v1/device-session/rotate';
    return result.toString();
  }
  expected.pathname = '/v1/device-session/rotate';
  expected.search = ''; expected.hash = '';
  return expected.toString();
}

export function deriveRelayDeviceResetUrl(relayUrlInput: string, resultUrlInput?: string, allowLoopbackInsecure = false): string {
  const url = new URL(deriveRelaySessionRotateUrl(relayUrlInput, resultUrlInput, allowLoopbackInsecure));
  url.pathname = '/v1/device-self/reset';
  return url.toString();
}
