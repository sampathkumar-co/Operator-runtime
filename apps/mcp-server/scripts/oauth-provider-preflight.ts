import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateOAuthProviderMetadataDocument,
  verifyPublicOAuthProviderMetadata,
  type OAuthProviderAuthority
} from '../src/oauth-provider-preflight.ts';

export interface OAuthProviderConfig {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  introspectionEndpoint?: string;
  jwksEndpoint?: string;
  verificationMode: 'jwks' | 'introspection';
  readScope: string;
  writeScope: string;
  registrationMode: OAuthProviderAuthority['oauthRegistrationMode'];
}

export interface OAuthProviderPreflightOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}
export function oauthProviderConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OAuthProviderConfig {
  return {
    issuer: required(env, 'OPERATOR_OAUTH_ISSUER'),
    authorizationEndpoint: required(env, 'OPERATOR_OAUTH_AUTHORIZATION_URL'),
    tokenEndpoint: required(env, 'OPERATOR_OAUTH_TOKEN_URL'),
    introspectionEndpoint: optional(env, 'OPERATOR_OAUTH_INTROSPECTION_URL'),
    jwksEndpoint: optional(env, 'OPERATOR_OAUTH_JWKS_URL'),
    verificationMode: verificationMode(required(env, 'OPERATOR_OAUTH_VERIFICATION_MODE')),
    readScope: required(env, 'OPERATOR_OAUTH_READ_SCOPE'),
    writeScope: required(env, 'OPERATOR_OAUTH_WRITE_SCOPE'),
    registrationMode: registrationMode(env.OPERATOR_OAUTH_CLIENT_REGISTRATION_MODE?.trim() || 'cimd')
  };
}

export async function runOAuthProviderPreflight(
  config = oauthProviderConfigFromEnv(),
  options: OAuthProviderPreflightOptions = {}
): Promise<Record<string, unknown>> {
  const authority = authorityFromConfig(config);
  const verified = await verifyPublicOAuthProviderMetadata(authority, options);
  return {
    schemaVersion: 1,
    generatedAtUtc: new Date().toISOString(),
    issuer: authority.oauthIssuerIdentifier,
    metadataUrl: verified.discoveryUrl,
    pkce: 'S256',
    registrationMode: verified.registrationMode,
    issuerIdentification: verified.issuerIdentification,
    scopes: [authority.readScope, authority.writeScope],
    endpoints: {
      authorization: 'PASS',
      token: 'PASS',
      verification: authority.oauthVerificationMode === 'jwks' ? 'JWKS_PASS' : 'INTROSPECTION_PASS'
    },
    externalGates: {
      resourceAudienceEcho: 'REQUIRES_LIVE_AUTHORIZATION_FLOW',
      redirectUriAllowlist: 'REQUIRES_PLUGIN_MANAGEMENT_VALUE'
    }
  };
}

export function validateProviderMetadata(
  metadata: Record<string, unknown>,
  config: OAuthProviderConfig
): { registrationMode: OAuthProviderAuthority['oauthRegistrationMode'] } {
  const authority = authorityFromConfig(config);
  validateOAuthProviderMetadataDocument(metadata, authority);
  return { registrationMode: authority.oauthRegistrationMode };
}
function authorityFromConfig(config: OAuthProviderConfig): OAuthProviderAuthority {
  const issuerIdentifier = requiredValue(config.issuer, 'OAuth issuer');
  const issuer = strictHttps(issuerIdentifier, 'OAuth issuer');
  const authorization = strictHttps(config.authorizationEndpoint, 'OAuth authorization endpoint');
  const token = strictHttps(config.tokenEndpoint, 'OAuth token endpoint');
  const verification = verificationMode(config.verificationMode);
  const introspection = verification === 'introspection'
    ? strictHttps(requiredValue(config.introspectionEndpoint, 'OAuth introspection endpoint'), 'OAuth introspection endpoint') : undefined;
  const jwks = verification === 'jwks'
    ? strictHttps(requiredValue(config.jwksEndpoint, 'OAuth JWKS endpoint'), 'OAuth JWKS endpoint') : undefined;
  const readScope = validScope(config.readScope, 'OAuth read scope');
  const writeScope = validScope(config.writeScope, 'OAuth write scope');
  if (readScope === writeScope) throw new Error('OAuth read and write scopes must be distinct.');
  return {
    oauthIssuer: issuer,
    oauthIssuerIdentifier: issuerIdentifier,
    oauthAuthorizationEndpoint: authorization,
    oauthTokenEndpoint: token,
    oauthIntrospectionEndpoint: introspection,
    oauthJwksEndpoint: jwks,
    oauthVerificationMode: verification,
    readScope,
    writeScope,
    oauthRegistrationMode: registrationMode(config.registrationMode)
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for OAuth provider certification.`);
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function requiredValue(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${label} is required for OAuth provider certification.`);
  return text;
}

function verificationMode(value: string): 'jwks' | 'introspection' {
  if (value === 'jwks' || value === 'introspection') return value;
  throw new Error('OAuth verification mode must be jwks or introspection.');
}
function strictHttps(value: string, label: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} is invalid.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be credential-free HTTPS without query or fragment.`);
  }
  return url;
}

function validScope(value: string, label: string): string {
  const scope = String(value ?? '').trim();
  if (!scope || Buffer.byteLength(scope, 'utf8') > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(scope)) {
    throw new Error(`${label} is invalid.`);
  }
  return scope;
}

function registrationMode(value: string): OAuthProviderAuthority['oauthRegistrationMode'] {
  if (value === 'cimd' || value === 'dcr' || value === 'predefined') return value;
  throw new Error('OAuth client registration mode must be cimd, dcr, or predefined.');
}

const isEntrypoint = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  const receipt = await runOAuthProviderPreflight();
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}
