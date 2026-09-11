import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { OAuthIntrospectionVerifier } from '../src/oauth-introspection.ts';
import { principalFromAuthInfo, readPublicMcpEdgeConfig, resolveMcpBindHost } from '../src/public-edge.ts';

function publicEnv(): NodeJS.ProcessEnv {
  return {
    OPERATOR_MCP_PUBLIC_EDGE: '1',
    OPERATOR_EXECUTION_MODE: 'relay',
    OPERATOR_MCP_PUBLIC_BIND_ACK: 'TLS_TERMINATES_UPSTREAM',
    OPERATOR_MCP_PUBLIC_URL: 'https://edge.operator-runtime.dev/mcp',
    OPERATOR_MCP_HOST: '0.0.0.0',
    OPERATOR_OAUTH_ISSUER: 'https://login.operator-runtime.dev',
    OPERATOR_OAUTH_AUTHORIZATION_URL: 'https://login.operator-runtime.dev/authorize',
    OPERATOR_OAUTH_TOKEN_URL: 'https://login.operator-runtime.dev/token',
    OPERATOR_OAUTH_INTROSPECTION_URL: 'https://login.operator-runtime.dev/introspect',
    OPERATOR_OAUTH_AUDIENCE: 'operator-runtime',
    OPERATOR_OAUTH_INTROSPECTION_CLIENT_ID: 'operator-edge',
    OPERATOR_OAUTH_INTROSPECTION_CLIENT_SECRET: 'test-secret-not-production'
  };
}

test('public edge is opt-in and non-loopback bind remains denied by default', () => {
  assert.equal(readPublicMcpEdgeConfig({}), null);
  assert.throws(() => resolveMcpBindHost({ OPERATOR_MCP_HOST: '0.0.0.0' }, null), /literal loopback/);
});
test('public edge refuses unsafe or incomplete startup authority', () => {
  const env = publicEnv();
  assert.throws(() => readPublicMcpEdgeConfig({ ...env, OPERATOR_EXECUTION_MODE: 'local' }), /OPERATOR_EXECUTION_MODE=relay/i);
  assert.throws(() => readPublicMcpEdgeConfig({ ...env, OPERATOR_MCP_PUBLIC_BIND_ACK: '' }), /TLS_TERMINATES_UPSTREAM/);
  assert.throws(() => readPublicMcpEdgeConfig({ ...env, OPERATOR_MCP_PUBLIC_URL: 'http://edge.operator-runtime.dev/mcp' }), /HTTPS/);
  assert.throws(() => readPublicMcpEdgeConfig({ ...env, OPERATOR_MCP_PUBLIC_URL: 'https://edge.operator-runtime.dev/other' }), /exactly at \/mcp/);
  assert.throws(() => readPublicMcpEdgeConfig({ ...env, OPERATOR_OAUTH_INTROSPECTION_CLIENT_SECRET: '' }), /CLIENT_SECRET/);
  assert.throws(() => readPublicMcpEdgeConfig({ ...env, OPERATOR_MCP_PUBLIC_URL: 'https://operator.example.test/mcp' }), /reserved or private DNS hostname/);
  assert.throws(() => readPublicMcpEdgeConfig({ ...env, OPERATOR_MCP_PUBLIC_URL: 'https://203.0.113.10/mcp' }), /public DNS hostname/);
  assert.throws(() => readPublicMcpEdgeConfig({ ...env, OPERATOR_OAUTH_INTROSPECTION_URL: 'https://login.operator-runtime.dev/introspect?tenant=x' }), /without query or fragment/);
});

test('public edge builds OAuth metadata and permits only explicit literal public binds', () => {
  const env = publicEnv();
  const config = readPublicMcpEdgeConfig(env);
  assert.ok(config);
  assert.equal(config.publicUrl.toString(), 'https://edge.operator-runtime.dev/mcp');
  assert.deepEqual(config.requiredScopes, ['operator:mcp']);
  assert.equal(config.authMetadata.oauthMetadata.issuer, 'https://login.operator-runtime.dev/');
  assert.equal(config.authMetadata.resourceServerUrl.toString(), 'https://edge.operator-runtime.dev/mcp');
  assert.equal(resolveMcpBindHost(env, config), '0.0.0.0');
  assert.throws(() => resolveMcpBindHost({ ...env, OPERATOR_MCP_HOST: 'edge.internal' }, config), /literal wildcard or loopback/);
});
test('introspection verifier returns bounded secret-free AuthInfo', async () => {
  let seenBody = '';
  let seenAuthorization = '';
  const verifier = new OAuthIntrospectionVerifier({
    endpoint: new URL('https://login.operator-runtime.dev/introspect'),
    clientId: 'edge-client',
    clientSecret: 'edge-secret',
    issuer: 'https://login.operator-runtime.dev/',
    audience: 'operator-runtime',
    resourceUrl: new URL('https://edge.operator-runtime.dev/mcp')
  }, {
    fetchFn: async (_url, init) => {
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      seenBody = String(init?.body ?? '');
      seenAuthorization = new Headers(init?.headers).get('authorization') ?? '';
      return Response.json({
        active: true,
        exp: Math.floor(Date.now() / 1000) + 300,
        sub: 'user-123',
        client_id: 'chatgpt-client',
        aud: ['operator-runtime'],
        scope: 'operator:mcp profile'
      });
    }
  });
  const auth = await verifier.verifyAccessToken('opaque-token-value');
  assert.equal(auth.token, '');
  assert.equal(auth.clientId, 'chatgpt-client');
  assert.deepEqual(auth.scopes, ['operator:mcp', 'profile']);
  assert.equal(auth.resource?.toString(), 'https://edge.operator-runtime.dev/mcp');
  assert.deepEqual(auth.extra, { issuer: 'https://login.operator-runtime.dev/', subject: 'user-123' });
  assert.match(seenAuthorization, /^Basic /);
  assert.doesNotMatch(seenAuthorization, /opaque-token-value/);
  assert.match(seenBody, /token=opaque-token-value/);
});

test('introspection verifier rejects inactive, expired, or wrong-audience tokens', async () => {
  const make = (payload: Record<string, unknown>) => new OAuthIntrospectionVerifier({
    endpoint: new URL('https://login.operator-runtime.dev/introspect'),
    clientId: 'edge-client', clientSecret: 'edge-secret', issuer: 'https://login.operator-runtime.dev/',
    audience: 'operator-runtime', resourceUrl: new URL('https://edge.operator-runtime.dev/mcp')
  }, { fetchFn: async () => Response.json(payload) });
  await assert.rejects(() => make({ active: false }).verifyAccessToken('x'), /inactive/);
  await assert.rejects(() => make({ active: true, exp: 1, sub: 'u', client_id: 'c', aud: 'operator-runtime' }).verifyAccessToken('x'), /expired/);
  await assert.rejects(() => make({ active: true, exp: Math.floor(Date.now() / 1000) + 60, sub: 'u', client_id: 'c', aud: 'other' }).verifyAccessToken('x'), /audience/);
});
test('verified AuthInfo principal binding refuses retained tokens or resource mismatches', () => {
  const base: AuthInfo = {
    token: '', clientId: 'chatgpt-client', scopes: ['operator:mcp'],
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    resource: new URL('https://edge.operator-runtime.dev/mcp'),
    extra: { issuer: 'https://login.operator-runtime.dev/', subject: 'user-123' }
  };
  assert.deepEqual(
    principalFromAuthInfo(base, new URL('https://edge.operator-runtime.dev/mcp')),
    { issuer: 'https://login.operator-runtime.dev/', subject: 'user-123' }
  );
  assert.throws(() => principalFromAuthInfo({ ...base, token: 'must-not-propagate' }, base.resource!), /must not retain/);
  assert.throws(() => principalFromAuthInfo({ ...base, resource: new URL('https://other.operator-runtime.dev/mcp') }, base.resource!), /does not match/);
});
