const MAX_METADATA_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const CHATGPT_TOKEN_AUTH_METHODS = new Set([
  'none',
  'private_key_jwt',
  'client_secret_basic',
  'client_secret_post'
]);

export type OAuthRegistrationMode = 'cimd' | 'dcr' | 'predefined';
export type OAuthVerificationMode = 'jwks' | 'introspection';

export interface OAuthProviderAuthority {
  oauthIssuer: URL;
  oauthIssuerIdentifier: string;
  oauthAuthorizationEndpoint: URL;
  oauthTokenEndpoint: URL;
  oauthIntrospectionEndpoint?: URL;
  oauthJwksEndpoint?: URL;
  oauthVerificationMode: OAuthVerificationMode;
  readScope: string;
  writeScope: string;
  oauthRegistrationMode: OAuthRegistrationMode;
}

export interface OAuthProviderPreflightResult {
  discoveryUrl: string;
  registrationMode: OAuthRegistrationMode;
  issuerIdentification: boolean;
}

export async function verifyPublicOAuthProviderMetadata(
  config: OAuthProviderAuthority,
  options: { fetchFn?: typeof fetch; timeoutMs?: number } = {}
): Promise<OAuthProviderPreflightResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const failures: string[] = [];
  for (const discoveryUrl of discoveryUrls(config.oauthIssuer)) {
    try {
      const metadata = await fetchMetadata(discoveryUrl, fetchFn, timeoutMs);
      validateOAuthProviderMetadataDocument(metadata, config);
      return {
        discoveryUrl: discoveryUrl.toString(),
        registrationMode: config.oauthRegistrationMode,
        issuerIdentification: metadata.authorization_response_iss_parameter_supported === true
      };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`OAuth provider discovery validation failed: ${failures.join(' | ')}`);
}

function discoveryUrls(issuer: URL): URL[] {
  const path = issuer.pathname === '/' ? '' : issuer.pathname.replace(/\/$/, '');
  return [
    new URL(`/.well-known/oauth-authorization-server${path}`, issuer.origin),
    new URL(`${path}/.well-known/openid-configuration`, issuer.origin)
  ];
}

async function fetchMetadata(url: URL, fetchFn: typeof fetch, timeoutMs: number): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw new Error(`OAuth discovery fetch failed for ${url.origin}.`);
  }
  if (!response.ok) throw new Error(`OAuth discovery returned HTTP ${response.status} for ${url.origin}.`);
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!type.includes('json')) throw new Error(`OAuth discovery response from ${url.origin} is not JSON.`);
  const value = await readBoundedJson(response);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`OAuth discovery response from ${url.origin} is invalid.`);
  }
  return value as Record<string, unknown>;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('OAuth discovery response body is missing.');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > MAX_METADATA_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('OAuth discovery response is too large.');
    }
    chunks.push(Buffer.from(value));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('OAuth discovery response is invalid JSON.'); }
}

export function validateOAuthProviderMetadataDocument(metadata: Record<string, unknown>, config: OAuthProviderAuthority): void {
  exactString(metadata.issuer, config.oauthIssuerIdentifier, 'issuer');
  exactUrl(metadata.authorization_endpoint, config.oauthAuthorizationEndpoint, 'authorization_endpoint');
  exactUrl(metadata.token_endpoint, config.oauthTokenEndpoint, 'token_endpoint');
  if (config.oauthVerificationMode === 'jwks') {
    if (!config.oauthJwksEndpoint) throw new Error('OAuth JWKS authority is missing.');
    exactUrl(metadata.jwks_uri, config.oauthJwksEndpoint, 'jwks_uri');
  } else {
    if (!config.oauthIntrospectionEndpoint) throw new Error('OAuth introspection authority is missing.');
    exactUrl(metadata.introspection_endpoint, config.oauthIntrospectionEndpoint, 'introspection_endpoint');
  }
  requireArray(metadata.code_challenge_methods_supported, 'code_challenge_methods_supported', 'S256');
  // RFC 8414 allows supported scopes to be omitted from scopes_supported even when the field is present.
  if (metadata.scopes_supported !== undefined) stringArray(metadata.scopes_supported, 'scopes_supported');
  if (metadata.response_types_supported !== undefined) requireArray(metadata.response_types_supported, 'response_types_supported', 'code');
  if (metadata.grant_types_supported !== undefined) requireArray(metadata.grant_types_supported, 'grant_types_supported', 'authorization_code');
  validateRegistration(metadata, config.oauthRegistrationMode, config.oauthVerificationMode);
}
function validateRegistration(
  metadata: Record<string, unknown>,
  mode: OAuthRegistrationMode,
  verificationMode: OAuthVerificationMode
): void {
  const methods = stringArray(metadata.token_endpoint_auth_methods_supported, 'token_endpoint_auth_methods_supported');
  if (!methods.some((method) => CHATGPT_TOKEN_AUTH_METHODS.has(method))) {
    throw new Error('OAuth token endpoint has no ChatGPT-compatible client authentication method.');
  }
  if (mode === 'cimd') {
    if (metadata.client_id_metadata_document_supported !== true) {
      throw new Error('OAuth provider does not advertise CIMD client registration.');
    }
    if (!methods.some((method) => method === 'none' || method === 'private_key_jwt')) {
      throw new Error('OAuth CIMD requires none or private_key_jwt token endpoint authentication.');
    }
  } else if (mode === 'dcr') {
    const registration = metadata.registration_endpoint;
    if (typeof registration !== 'string') throw new Error('OAuth provider does not advertise a DCR registration_endpoint.');
    requireSafeHttpsUrl(registration, 'registration_endpoint');
  }
  if (verificationMode === 'introspection') {
    requireArray(metadata.introspection_endpoint_auth_methods_supported, 'introspection_endpoint_auth_methods_supported', 'client_secret_basic');
  }
}

function exactString(value: unknown, expected: string, label: string): void {
  if (value !== expected) throw new Error(`OAuth ${label} does not match configured authority.`);
}
function exactUrl(value: unknown, expected: URL, label: string): void {
  if (typeof value !== 'string') throw new Error(`OAuth ${label} is missing.`);
  const parsed = requireSafeHttpsUrl(value, label);
  if (parsed.toString() !== expected.toString()) {
    throw new Error(`OAuth ${label} does not match configured authority.`);
  }
}

function requireSafeHttpsUrl(input: string, label: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error(`OAuth ${label} is invalid.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`OAuth ${label} must be credential-free HTTPS.`);
  }
  return url;
}

function requireArray(value: unknown, label: string, required: string): void {
  const values = stringArray(value, label);
  if (!values.includes(required)) throw new Error(`OAuth ${label} must include ${required}.`);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`OAuth ${label} is invalid.`);
  return value.map((entry) => {
    if (typeof entry !== 'string' || !entry || entry.length > 512 || /[\0\r\n]/.test(entry)) {
      throw new Error(`OAuth ${label} is invalid.`);
    }
    return entry;
  });
}

function boundedTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 500 || value > 30_000) {
    throw new Error('OAuth discovery timeout must be between 500 and 30000 ms.');
  }
  return value;
}
