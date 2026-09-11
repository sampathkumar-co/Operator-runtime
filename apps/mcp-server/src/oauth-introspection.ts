import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier
} from '@modelcontextprotocol/server';

const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface OAuthIntrospectionConfig {
  endpoint: URL;
  clientId: string;
  clientSecret: string;
  issuer: string;
  audience: string;
  resourceUrl: URL;
  timeoutMs?: number;
}

type FetchLike = typeof fetch;

export class OAuthIntrospectionVerifier implements OAuthTokenVerifier {
  #config: OAuthIntrospectionConfig;
  #fetch: FetchLike;

  constructor(config: OAuthIntrospectionConfig, options: { fetchFn?: FetchLike } = {}) {
    this.#config = validateConfig(config);
    this.#fetch = options.fetchFn ?? fetch;
  }

  async verifyAccessToken(tokenInput: string): Promise<AuthInfo> {
    const token = String(tokenInput ?? '');
    if (!token || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES || /[\0\r\n]/.test(token)) {
      throw invalidToken('Access token is invalid.');
    }

    const params = new URLSearchParams({ token });
    let response: Response;
    try {
      response = await this.#fetch(this.#config.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          authorization: basicAuth(this.#config.clientId, this.#config.clientSecret),
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: params.toString(),
        signal: AbortSignal.timeout(this.#config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      });
    } catch {
      throw serverError('OAuth token introspection failed.');
    }

    if (!response.ok) throw serverError(`OAuth token introspection returned HTTP ${response.status}.`);
    const raw = await readBoundedJson(response);
    return toAuthInfo(raw, this.#config);
  }
}

function validateConfig(input: OAuthIntrospectionConfig): OAuthIntrospectionConfig {
  if (input.endpoint.protocol !== 'https:' || input.endpoint.username || input.endpoint.password || input.endpoint.search || input.endpoint.hash) {
    throw new Error('OAuth introspection endpoint must be credential-free HTTPS.');
  }
  if (input.resourceUrl.protocol !== 'https:' || input.resourceUrl.username || input.resourceUrl.password || input.resourceUrl.search || input.resourceUrl.hash) {
    throw new Error('Public MCP resource URL must be credential-free HTTPS without query or fragment.');
  }
  const clientId = bounded(input.clientId, 512, 'OAuth introspection client ID');
  const clientSecret = bounded(input.clientSecret, 4096, 'OAuth introspection client secret');
  const issuer = bounded(input.issuer, 2048, 'OAuth issuer');
  const issuerUrl = new URL(issuer);
  if (issuerUrl.protocol !== 'https:' || issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash) {
    throw new Error('OAuth issuer must be credential-free HTTPS without query or fragment.');
  }
  const audience = bounded(input.audience, 2048, 'OAuth audience');
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30_000) {
    throw new Error('OAuth introspection timeout must be between 500 and 30000 ms.');
  }
  return { ...input, clientId, clientSecret, issuer: issuerUrl.toString(), audience, timeoutMs };
}

function toAuthInfo(input: unknown, config: OAuthIntrospectionConfig): AuthInfo {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw serverError('OAuth introspection response is invalid.');
  const raw = input as Record<string, unknown>;
  if (raw.active !== true) throw invalidToken('Access token is inactive.');

  const exp = Number(raw.exp);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) throw invalidToken('Access token has expired or has no valid expiration.');
  const subject = boundedClaim(raw.sub, 1024, 'subject');
  if (raw.iss !== undefined && boundedClaim(raw.iss, 2048, 'issuer') !== config.issuer) throw invalidToken('Access token issuer is invalid.');
  const clientId = boundedClaim(raw.client_id ?? raw.azp, 512, 'client_id');
  if (!audienceMatches(raw.aud, config.audience)) throw invalidToken('Access token audience is invalid.');
  const scopes = parseScopes(raw.scope);
  return {
    token: '',
    clientId,
    scopes,
    expiresAt: exp,
    resource: new URL(config.resourceUrl),
    extra: { issuer: config.issuer, subject }
  };
}

function audienceMatches(input: unknown, expected: string): boolean {
  if (typeof input === 'string') return input === expected;
  if (Array.isArray(input)) return input.some((value) => value === expected);
  return false;
}

function parseScopes(input: unknown): string[] {
  const values = typeof input === 'string'
    ? input.trim().split(/\s+/).filter(Boolean)
    : Array.isArray(input) ? input : [];
  const scopes = values.map((value) => boundedClaim(value, 256, 'scope'));
  return [...new Set(scopes)].slice(0, 100);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const type = response.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) throw serverError('OAuth introspection response must be JSON.');
  if (!response.body) throw serverError('OAuth introspection response body is missing.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw serverError('OAuth introspection response is too large.');
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw serverError('OAuth introspection response is invalid JSON.'); }
}

function basicAuth(clientId: string, clientSecret: string): string {
  const id = encodeURIComponent(clientId);
  const secret = encodeURIComponent(clientSecret);
  return `Basic ${Buffer.from(`${id}:${secret}`, 'utf8').toString('base64')}`;
}

function bounded(value: string, max: number, label: string): string {
  const text = String(value ?? '').trim();
  if (!text || Buffer.byteLength(text, 'utf8') > max || /[\0\r\n]/.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function boundedClaim(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string') throw invalidToken(`Access token ${label} claim is invalid.`);
  const text = value.trim();
  if (!text || Buffer.byteLength(text, 'utf8') > max || /[\0\r\n]/.test(text)) {
    throw invalidToken(`Access token ${label} claim is invalid.`);
  }
  return text;
}

function invalidToken(message: string): OAuthError {
  return new OAuthError(OAuthErrorCode.InvalidToken, message);
}

function serverError(message: string): OAuthError {
  return new OAuthError(OAuthErrorCode.ServerError, message);
}
