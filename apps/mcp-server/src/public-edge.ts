import { isIP } from 'node:net';
import {
  type AuthInfo,
  type AuthMetadataOptions,
  type OAuthTokenVerifier
} from '@modelcontextprotocol/server';
import type { AccountPrincipal } from '../../../src/core/account-device-registry.ts';
import { requireLiteralLoopbackBindHost } from '../../../src/core/network-authority.ts';
import { OAuthIntrospectionVerifier } from './oauth-introspection.ts';
import { OAuthJwtVerifier } from './oauth-jwt.ts';

const PUBLIC_BIND_ACK = 'TLS_TERMINATES_UPSTREAM';
export const DEFAULT_READ_SCOPE = 'operator:read';
export const DEFAULT_WRITE_SCOPE = 'operator:write';

export type OAuthClientRegistrationMode = 'cimd' | 'dcr' | 'predefined';
export type OAuthTokenVerificationMode = 'jwks' | 'introspection';

export interface PublicMcpEdgeConfig {
  publicUrl: URL;
  verifier: OAuthTokenVerifier;
  requiredScopes: string[];
  readScope: string;
  writeScope: string;
  challengeToken?: string;
  authMetadata: AuthMetadataOptions;
  allowedHostnames: string[];
  oauthIssuer: URL;
  oauthAuthorizationEndpoint: URL;
  oauthTokenEndpoint: URL;
  oauthIntrospectionEndpoint?: URL;
  oauthJwksEndpoint?: URL;
  oauthVerificationMode: OAuthTokenVerificationMode;
  oauthRegistrationMode: OAuthClientRegistrationMode;
  developerScope?: string;
}

export function readPublicMcpEdgeConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { fetchFn?: typeof fetch } = {}
): PublicMcpEdgeConfig | null {
  const enabled = env.OPERATOR_MCP_PUBLIC_EDGE?.trim();
  if (enabled === undefined || enabled === '' || enabled === '0') return null;
  if (enabled !== '1') throw new Error('OPERATOR_MCP_PUBLIC_EDGE must be 0 or 1.');
  if ((env.OPERATOR_EXECUTION_MODE ?? '').trim().toLowerCase() !== 'relay') {
    throw new Error('Public MCP edge requires OPERATOR_EXECUTION_MODE=relay.');
  }
  if (env.OPERATOR_MCP_PUBLIC_BIND_ACK !== PUBLIC_BIND_ACK) {
    throw new Error(`Public MCP edge requires OPERATOR_MCP_PUBLIC_BIND_ACK=${PUBLIC_BIND_ACK}.`);
  }
  const publicUrl = publicMcpUrl(requiredEnv(env, 'OPERATOR_MCP_PUBLIC_URL'));
  const issuerIdentifier = requiredEnv(env, 'OPERATOR_OAUTH_ISSUER');
  const issuer = publicHttpsUrl(issuerIdentifier, 'OAuth issuer');
  const authorizationEndpoint = publicHttpsUrl(requiredEnv(env, 'OPERATOR_OAUTH_AUTHORIZATION_URL'), 'OAuth authorization endpoint');
  const tokenEndpoint = publicHttpsUrl(requiredEnv(env, 'OPERATOR_OAUTH_TOKEN_URL'), 'OAuth token endpoint');
  const oauthVerificationMode = verificationMode(requiredEnv(env, 'OPERATOR_OAUTH_VERIFICATION_MODE'));
  const introspectionEndpoint = oauthVerificationMode === 'introspection'
    ? publicHttpsUrl(requiredEnv(env, 'OPERATOR_OAUTH_INTROSPECTION_URL'), 'OAuth introspection endpoint') : undefined;
  const jwksEndpoint = oauthVerificationMode === 'jwks'
    ? publicHttpsUrl(requiredEnv(env, 'OPERATOR_OAUTH_JWKS_URL'), 'OAuth JWKS endpoint') : undefined;
  const audience = bounded(requiredEnv(env, 'OPERATOR_OAUTH_AUDIENCE'), 2048, 'OAuth audience');
  if (audience !== publicUrl.toString()) throw new Error('OPERATOR_OAUTH_AUDIENCE must exactly match OPERATOR_MCP_PUBLIC_URL.');
  const readScope = validScope(env.OPERATOR_OAUTH_READ_SCOPE?.trim() || DEFAULT_READ_SCOPE);
  const writeScope = validScope(env.OPERATOR_OAUTH_WRITE_SCOPE?.trim() || DEFAULT_WRITE_SCOPE);
  if (readScope === writeScope) throw new Error('OAuth read and write scopes must be distinct.');
  const developerEdge = env.OPERATOR_MCP_DEVELOPER_EDGE?.trim() === '1';
  const developerScope = developerEdge ? validScope(env.OPERATOR_OAUTH_DEVELOPER_SCOPE?.trim() || 'operator:developer') : undefined;
  if (developerScope && [readScope, writeScope].includes(developerScope)) throw new Error('OAuth developer scope must be distinct from read/write scopes.');
  const challengeToken = optionalChallengeToken(env.OPENAI_APPS_CHALLENGE_TOKEN);
  const oauthRegistrationMode = registrationMode(env.OPERATOR_OAUTH_CLIENT_REGISTRATION_MODE?.trim() || 'cimd');
  const verifier: OAuthTokenVerifier = oauthVerificationMode === 'jwks'
    ? new OAuthJwtVerifier({ jwksUrl: jwksEndpoint!, issuer: issuerIdentifier, audience, resourceUrl: publicUrl }, options)
    : new OAuthIntrospectionVerifier({
        endpoint: introspectionEndpoint!,
        clientId: bounded(requiredEnv(env, 'OPERATOR_OAUTH_INTROSPECTION_CLIENT_ID'), 512, 'OAuth introspection client ID'),
        clientSecret: bounded(requiredEnv(env, 'OPERATOR_OAUTH_INTROSPECTION_CLIENT_SECRET'), 4096, 'OAuth introspection client secret'),
        issuer: issuerIdentifier, audience, resourceUrl: publicUrl
      }, options);

  const authMetadata: AuthMetadataOptions = {
    oauthMetadata: {
      issuer: issuerIdentifier,
      authorization_endpoint: authorizationEndpoint.toString(),
      token_endpoint: tokenEndpoint.toString(),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      scopes_supported: [readScope, writeScope, ...(developerScope ? [developerScope] : [])],
      code_challenge_methods_supported: ['S256'],
      ...(jwksEndpoint ? { jwks_uri: jwksEndpoint.toString() } : {}),
      ...(introspectionEndpoint ? {
        introspection_endpoint: introspectionEndpoint.toString(),
        introspection_endpoint_auth_methods_supported: ['client_secret_basic']
      } : {})
    },
    resourceServerUrl: publicUrl,
    scopesSupported: [readScope, writeScope, ...(developerScope ? [developerScope] : [])],
    resourceName: 'Mecord Connect'
  };
  return {
    publicUrl,
    verifier,
    requiredScopes: [readScope],
    readScope,
    writeScope,
    challengeToken,
    authMetadata,
    allowedHostnames: [publicUrl.hostname],
    oauthIssuer: issuer,
    oauthAuthorizationEndpoint: authorizationEndpoint,
    oauthTokenEndpoint: tokenEndpoint,
    oauthIntrospectionEndpoint: introspectionEndpoint,
    oauthJwksEndpoint: jwksEndpoint,
    oauthVerificationMode,
    oauthRegistrationMode,
    developerScope
  };
}

export function resolveMcpBindHost(env: NodeJS.ProcessEnv, publicEdge: PublicMcpEdgeConfig | null): string {
  if (!publicEdge) return requireLiteralLoopbackBindHost(env.OPERATOR_MCP_HOST ?? '127.0.0.1', 'MCP server');
  const host = env.OPERATOR_MCP_HOST?.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new Error('Public MCP edge requires explicit OPERATOR_MCP_HOST.');
  if (!['0.0.0.0', '::', '127.0.0.1', '::1'].includes(host)) {
    throw new Error('Public MCP edge bind host must be a literal wildcard or loopback address.');
  }
  return host;
}
export function principalFromAuthInfo(authInfo: AuthInfo | undefined, expectedResource: URL): AccountPrincipal {
  if (!authInfo) throw new Error('Authenticated public MCP request is missing AuthInfo.');
  if (authInfo.token) throw new Error('Verified AuthInfo must not retain the raw bearer token.');
  if (authInfo.resource?.toString() !== expectedResource.toString()) {
    throw new Error('Verified AuthInfo resource does not match the public MCP resource.');
  }
  const issuer = boundedClaim(authInfo.extra?.issuer, 2048, 'issuer');
  const subject = boundedClaim(authInfo.extra?.subject, 1024, 'subject');
  return { issuer, subject };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the public MCP edge.`);
  return value;
}

function publicMcpUrl(input: string): URL {
  const url = publicHttpsUrl(input, 'Public MCP URL');
  if (url.pathname !== '/mcp') throw new Error('OPERATOR_MCP_PUBLIC_URL must end exactly at /mcp.');
  if (url.port && url.port !== '443') throw new Error('OPERATOR_MCP_PUBLIC_URL must use the standard HTTPS port.');
  return url;
}

function publicHttpsUrl(input: string, label: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error(`${label} is invalid.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be credential-free HTTPS without query or fragment.`);
  }
  if (['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase().replace(/^\[|\]$/g, ''))) {
    throw new Error(`${label} must not use a loopback hostname.`);
  }
  requirePublicDnsHostname(url.hostname, label);
  return url;
}

function requirePublicDnsHostname(hostnameInput: string, label: string): void {
  const hostname = hostnameInput.toLowerCase().replace(/\.$/, '');
  if (!hostname.includes('.') || isIP(hostname) !== 0) throw new Error(`${label} must use a public DNS hostname.`);
  const reserved = ['.localhost', '.local', '.internal', '.invalid', '.example', '.test', '.onion'];
  const examples = ['example.com', 'example.net', 'example.org'];
  if (reserved.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix))
    || examples.some((name) => hostname === name || hostname.endsWith(`.${name}`))) {
    throw new Error(`${label} must not use a reserved or private DNS hostname.`);
  }
}
function validScope(input: string): string {
  const scope = bounded(input, 256, 'OAuth required scope');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(scope)) throw new Error('OAuth required scope is invalid.');
  return scope;
}

function registrationMode(input: string): OAuthClientRegistrationMode {
  if (input === 'cimd' || input === 'dcr' || input === 'predefined') return input;
  throw new Error('OPERATOR_OAUTH_CLIENT_REGISTRATION_MODE must be cimd, dcr, or predefined.');
}

function verificationMode(input: string): OAuthTokenVerificationMode {
  if (input === 'jwks' || input === 'introspection') return input;
  throw new Error('OPERATOR_OAUTH_VERIFICATION_MODE must be jwks or introspection.');
}

function optionalChallengeToken(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const token = value.trim();
  if (Buffer.byteLength(token, 'utf8') > 2048 || /[\0\r\n]/.test(token)) {
    throw new Error('OPENAI_APPS_CHALLENGE_TOKEN is invalid.');
  }
  return token;
}

function bounded(value: string, max: number, label: string): string {
  const text = String(value ?? '').trim();
  if (!text || Buffer.byteLength(text, 'utf8') > max || /[\0\r\n]/.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function boundedClaim(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string') throw new Error(`Verified AuthInfo ${label} is invalid.`);
  const text = value.trim();
  if (!text || Buffer.byteLength(text, 'utf8') > max || /[\0\r\n]/.test(text)) throw new Error(`Verified AuthInfo ${label} is invalid.`);
  return text;
}
