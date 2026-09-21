import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify
} from 'jose';
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier
} from '@modelcontextprotocol/server';

const MAX_TOKEN_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_MAX_AGE_MS = 10 * 60_000;
const DEFAULT_COOLDOWN_MS = 30_000;

export interface OAuthJwtConfig {
  jwksUrl: URL;
  issuer: string;
  audience: string;
  resourceUrl: URL;
  timeoutMs?: number;
}

type FetchLike = typeof fetch;
export class OAuthJwtVerifier implements OAuthTokenVerifier {
  #config: Required<OAuthJwtConfig>;
  #jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(config: OAuthJwtConfig, options: { fetchFn?: FetchLike } = {}) {
    this.#config = validateConfig(config);
    const fetchFn = options.fetchFn ?? fetch;
    this.#jwks = createRemoteJWKSet(this.#config.jwksUrl, {
      timeoutDuration: this.#config.timeoutMs,
      cooldownDuration: DEFAULT_COOLDOWN_MS,
      cacheMaxAge: DEFAULT_CACHE_MAX_AGE_MS,
      [customFetch]: async (url, request) => fetchFn(url, {
        method: 'GET',
        redirect: 'error',
        headers: request.headers,
        signal: request.signal
      })
    });
  }

  async verifyAccessToken(tokenInput: string): Promise<AuthInfo> {
    const token = String(tokenInput ?? '');
    if (!token || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES || /[\0\r\n]/.test(token)) {
      throw invalidToken('Access token is invalid.');
    }
    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.#jwks, {
        issuer: this.#config.issuer,
        audience: this.#config.audience,
        algorithms: ['RS256']
      });
      if (protectedHeader.alg !== 'RS256') throw invalidToken('Access token signing algorithm is invalid.');
      if (!Number.isFinite(payload.exp)) throw invalidToken('Access token has no valid expiration.');
      const subject = boundedClaim(payload.sub, 1024, 'subject');
      const clientId = boundedClaim(payload.client_id ?? payload.azp, 512, 'client_id');
      const scopes = parseTokenScopes(payload.scope, payload.scp);
      return {
        token: '',
        clientId,
        scopes,
        expiresAt: payload.exp,
        resource: new URL(this.#config.resourceUrl),
        extra: { issuer: this.#config.issuer, subject }
      };
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      throw invalidToken('Access token signature or claims are invalid.');
    }
  }
}
function validateConfig(input: OAuthJwtConfig): Required<OAuthJwtConfig> {
  const issuer = bounded(input.issuer, 2048, 'OAuth issuer');
  const issuerUrl = strictHttps(new URL(issuer), 'OAuth issuer');
  const jwksUrl = strictHttps(input.jwksUrl, 'OAuth JWKS endpoint');
  const resourceUrl = strictHttps(input.resourceUrl, 'Public MCP resource URL');
  if (jwksUrl.origin !== issuerUrl.origin) {
    throw new Error('OAuth JWKS endpoint must use the same origin as the OAuth issuer.');
  }
  const audience = bounded(input.audience, 2048, 'OAuth audience');
  if (audience !== resourceUrl.toString()) {
    throw new Error('OAuth audience must exactly match the public MCP resource URL.');
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30_000) {
    throw new Error('OAuth JWKS timeout must be between 500 and 30000 ms.');
  }
  return {
    jwksUrl,
    issuer,
    audience,
    resourceUrl,
    timeoutMs
  };
}
function strictHttps(url: URL, label: string): URL {
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be credential-free HTTPS without query or fragment.`);
  }
  return url;
}

function parseTokenScopes(scope: unknown, scp: unknown): string[] {
  const oauthScopes = parseScopes(scope);
  const jwtScopes = parseScopes(scp);
  if (oauthScopes.length && jwtScopes.length
    && (oauthScopes.length !== jwtScopes.length || oauthScopes.some((value) => !jwtScopes.includes(value)))) {
    throw invalidToken('Access token scope claims do not match.');
  }
  return oauthScopes.length ? oauthScopes : jwtScopes;
}

function parseScopes(input: unknown): string[] {
  const values = typeof input === 'string'
    ? input.trim().split(/\s+/).filter(Boolean)
    : Array.isArray(input) ? input : [];
  const scopes = values.map((value) => boundedClaim(value, 256, 'scope'));
  return [...new Set(scopes)].slice(0, 100);
}

function bounded(value: string, max: number, label: string): string {
  const text = String(value ?? '').trim();
  if (!text || Buffer.byteLength(text, 'utf8') > max || /[\0\r\n]/.test(text)) {
    throw new Error(`${label} is invalid.`);
  }
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
