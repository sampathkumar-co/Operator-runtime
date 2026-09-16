import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runOAuthProviderPreflight,
  validateProviderMetadata,
  type OAuthProviderConfig
} from '../scripts/oauth-provider-preflight.ts';

const config: OAuthProviderConfig = {
  issuer: 'https://auth.operator.dev',
  authorizationEndpoint: 'https://auth.operator.dev/authorize',
  tokenEndpoint: 'https://auth.operator.dev/token',
  introspectionEndpoint: 'https://auth.operator.dev/introspect',
  verificationMode: 'introspection',
  readScope: 'operator:read',
  writeScope: 'operator:write',
  registrationMode: 'cimd'
};

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: config.issuer,
    authorization_endpoint: config.authorizationEndpoint,
    token_endpoint: config.tokenEndpoint,
    introspection_endpoint: config.introspectionEndpoint,
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [config.readScope, config.writeScope],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    introspection_endpoint_auth_methods_supported: ['client_secret_basic'],
    ...overrides
  };
}test('provider metadata accepts ChatGPT-compatible CIMD', () => {
  assert.deepEqual(validateProviderMetadata(metadata(), config), { registrationMode: 'cimd' });
});

test('provider metadata accepts DCR when CIMD is unavailable', () => {
  const value = metadata({
    client_id_metadata_document_supported: false,
    registration_endpoint: 'https://auth.operator.dev/register',
    token_endpoint_auth_methods_supported: ['client_secret_basic']
  });
  assert.deepEqual(validateProviderMetadata(value, { ...config, registrationMode: 'dcr' }), { registrationMode: 'dcr' });
});
test('provider metadata fails closed on PKCE, malformed scope metadata, endpoint, or registration drift', () => {
  assert.throws(
    () => validateProviderMetadata(metadata({ code_challenge_methods_supported: ['plain'] }), config),
    /S256/
  );
  assert.deepEqual(
    validateProviderMetadata(metadata({ scopes_supported: ['openid', 'profile', 'email'] }), config),
    { registrationMode: 'cimd' }
  );
  assert.throws(
    () => validateProviderMetadata(metadata({ scopes_supported: ['openid', 42] }), config),
    /scopes_supported.*invalid/i
  );
  assert.throws(
    () => validateProviderMetadata(metadata({ token_endpoint: 'https://evil.example/token' }), config),
    /token_endpoint/
  );
  assert.throws(() => validateProviderMetadata(metadata({
    client_id_metadata_document_supported: false,
    token_endpoint_auth_methods_supported: ['none']
  }), config), /CIMD client registration/);
});
test('provider metadata validates JWKS verification without requiring introspection metadata', () => {
  const jwksConfig: OAuthProviderConfig = {
    ...config,
    verificationMode: 'jwks',
    introspectionEndpoint: undefined,
    jwksEndpoint: 'https://auth.operator.dev/.well-known/jwks.json'
  };
  const value = metadata({
    introspection_endpoint: undefined,
    introspection_endpoint_auth_methods_supported: undefined,
    jwks_uri: jwksConfig.jwksEndpoint
  });
  assert.deepEqual(validateProviderMetadata(value, jwksConfig), { registrationMode: 'cimd' });
});

test('live preflight falls back from OAuth metadata to OIDC and emits bounded evidence', async () => {
  const requests: Array<{ url: string; redirect?: RequestRedirect }> = [];
  const fetchFn = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, redirect: init?.redirect });
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return new Response('', { status: 404 });
    }
    return new Response(JSON.stringify(metadata()), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  const receipt = await runOAuthProviderPreflight(config, { fetchFn, timeoutMs: 1000 });
  assert.equal(receipt.registrationMode, 'cimd');
  assert.equal(receipt.issuer, config.issuer);
  assert.equal(receipt.pkce, 'S256');
  assert.equal(receipt.metadataUrl, 'https://auth.operator.dev/.well-known/openid-configuration');
  assert.deepEqual(requests.map(({ redirect }) => redirect), ['error', 'error']);
});
