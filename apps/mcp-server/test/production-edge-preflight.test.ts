import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { PUBLIC_NOTICES_FINAL_ACK } from '../src/public-pages.ts';
import { runProductionEdgePreflight } from '../scripts/production-edge-preflight.ts';


const noticesDir = mkdtempSync(path.join(tmpdir(), 'operator-preflight-notices-'));
writeFileSync(path.join(noticesDir, 'privacy.md'), '# Final Privacy\nController and retention are finalized.');
writeFileSync(path.join(noticesDir, 'terms.md'), '# Final Terms\nEffective production terms.');
writeFileSync(path.join(noticesDir, 'support.md'), '# Final Support\nSupport and private security channel configured.');
after(() => rmSync(noticesDir, { recursive: true, force: true }));

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPERATOR_EXECUTION_MODE: 'relay',
    OPERATOR_MCP_PUBLIC_EDGE: '1',
    OPERATOR_MCP_PUBLIC_BIND_ACK: 'TLS_TERMINATES_UPSTREAM',
    OPERATOR_MCP_HOST: '0.0.0.0',
    OPERATOR_MCP_PUBLIC_URL: 'https://mcp.operator.dev/mcp',
    OPERATOR_OAUTH_ISSUER: 'https://auth.operator.dev/',
    OPERATOR_OAUTH_AUTHORIZATION_URL: 'https://auth.operator.dev/authorize',
    OPERATOR_OAUTH_TOKEN_URL: 'https://auth.operator.dev/token',
    OPERATOR_OAUTH_VERIFICATION_MODE: 'jwks',
    OPERATOR_OAUTH_JWKS_URL: 'https://auth.operator.dev/.well-known/jwks.json',
    OPERATOR_OAUTH_AUDIENCE: 'https://mcp.operator.dev/mcp',
    OPERATOR_OAUTH_READ_SCOPE: 'operator:read',
    OPERATOR_OAUTH_WRITE_SCOPE: 'operator:write',
    OPERATOR_RELAY_CONTROL_TOKEN: '0123456789abcdef0123456789abcdef',
    OPERATOR_PUBLIC_NOTICES_DIR: noticesDir,
    OPERATOR_PUBLIC_NOTICES_FINAL_ACK: PUBLIC_NOTICES_FINAL_ACK,
    ...overrides
  };
}
function providerMetadata(): Record<string, unknown> {
  return {
    issuer: 'https://auth.operator.dev/',
    authorization_endpoint: 'https://auth.operator.dev/authorize',
    token_endpoint: 'https://auth.operator.dev/token',
    jwks_uri: 'https://auth.operator.dev/.well-known/jwks.json',
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['operator:read', 'operator:write'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: ['none', 'private_key_jwt']
  };
}

const fetchFn = (async () => new Response(JSON.stringify(providerMetadata()), {
  status: 200,
  headers: { 'content-type': 'application/json' }
})) as typeof fetch;

test('production preflight validates edge authority and OAuth metadata without exposing secrets', async () => {
  const receipt = await runProductionEdgePreflight({ env: env(), fetchFn });
  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.publicMcpUrl, 'https://mcp.operator.dev/mcp');
  assert.equal(receipt.bindHost, '0.0.0.0');
  assert.deepEqual(receipt.reviewerPages, ['/', '/privacy', '/terms', '/support']);
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /0123456789abcdef0123456789abcdef/);
});

test('production preflight rejects placeholders, weak relay secrets, and unsafe binds before network work', async () => {
  let calls = 0;
  const neverFetch = (async () => {
    calls += 1;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  await assert.rejects(
    () => runProductionEdgePreflight({ env: env({ OPERATOR_MCP_PUBLIC_URL: 'https://mcp.your-domain.tld/mcp' }), fetchFn: neverFetch }),
    /placeholder|reserved|private DNS/i
  );
  await assert.rejects(
    () => runProductionEdgePreflight({ env: env({ OPERATOR_OAUTH_ISSUER: 'https://replace-with-auth.company.dev/' }), fetchFn: neverFetch }),
    /OPERATOR_OAUTH_ISSUER.*deployment placeholder/
  );
  await assert.rejects(
    () => runProductionEdgePreflight({ env: env({ OPERATOR_RELAY_CONTROL_TOKEN: 'REQUIRED_INSTALL_PRODUCTION_SECRET' }), fetchFn: neverFetch }),
    /deployment placeholder/
  );
  await assert.rejects(
    () => runProductionEdgePreflight({ env: env({ OPENAI_APPS_CHALLENGE_TOKEN: 'REQUIRED_OPENAI_CHALLENGE_TOKEN' }), fetchFn: neverFetch }),
    /OPENAI_APPS_CHALLENGE_TOKEN.*deployment placeholder/
  );
  await assert.rejects(
    () => runProductionEdgePreflight({ env: env({ OPERATOR_OAUTH_READ_SCOPE: 'REQUIRED_READ_SCOPE' }), fetchFn: neverFetch }),
    /OPERATOR_OAUTH_READ_SCOPE.*deployment placeholder/
  );
  await assert.rejects(
    () => runProductionEdgePreflight({ env: env({ OPERATOR_OAUTH_WRITE_SCOPE: 'REQUIRED_WRITE_SCOPE' }), fetchFn: neverFetch }),
    /OPERATOR_OAUTH_WRITE_SCOPE.*deployment placeholder/
  );
  await assert.rejects(
    () => runProductionEdgePreflight({ env: env({ OPERATOR_RELAY_CONTROL_TOKEN: 'too-short' }), fetchFn: neverFetch }),
    /at least 32 bytes/
  );
  await assert.rejects(
    () => runProductionEdgePreflight({ env: env({ OPERATOR_MCP_HOST: 'mcp.operator.dev' }), fetchFn: neverFetch }),
    /bind host/
  );
  await assert.rejects(
    () => runProductionEdgePreflight({ env: env({ OPERATOR_PUBLIC_NOTICES_FINAL_ACK: '' }), fetchFn: neverFetch }),
    /FINAL_ACK/
  );
  assert.equal(calls, 0);
});

test('production preflight allows required labels inside legitimate OAuth hostnames', async () => {
  const authority = 'https://required-login.company.dev';
  const metadata = {
    ...providerMetadata(),
    issuer: `${authority}/`,
    authorization_endpoint: `${authority}/authorize`,
    token_endpoint: `${authority}/token`,
    jwks_uri: `${authority}/.well-known/jwks.json`
  };
  let calls = 0;
  const authorityFetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify(metadata), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  const receipt = await runProductionEdgePreflight({
    env: env({
      OPERATOR_OAUTH_ISSUER: `${authority}/`,
      OPERATOR_OAUTH_AUTHORIZATION_URL: `${authority}/authorize`,
      OPERATOR_OAUTH_TOKEN_URL: `${authority}/token`,
      OPERATOR_OAUTH_JWKS_URL: `${authority}/.well-known/jwks.json`
    }),
    fetchFn: authorityFetch
  });
  assert.equal(receipt.status, 'PASS');
  assert.equal(calls, 1);
});
