import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPairingService, normalizePairingCode } from '../deploy/auth-portal/pairing.mjs';

function text(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
}

test('pairing code normalization is strict and human-friendly', () => {
  assert.equal(normalizePairingCode('abcd-2345'), 'ABCD-2345');
  assert.equal(normalizePairingCode('ABCD 2345'), 'ABCD-2345');
  assert.throws(() => normalizePairingCode('ABCI-2345'), /PAIR_CODE_INVALID/);
  assert.throws(() => normalizePairingCode('ABCD-1234'), /PAIR_CODE_INVALID/);
  assert.throws(() => normalizePairingCode('too-short'), /PAIR_CODE_INVALID/);
});

test('pairing service uses PKCE, hides device code from authorization URL, and claims with bearer token', async () => {
  let now = Date.parse('2026-09-21T16:30:00.000Z');
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const service = createPairingService({
    clock: () => now,
    fetchFn: async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.endsWith('/api/oidc/token')) {
        return new Response(JSON.stringify({ access_token: 'test-access-token-value' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.endsWith('/pair/api/claim')) {
        return new Response(JSON.stringify({ ok: true, status: 'claimed' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error('unexpected fetch');
    }
  });

  const started = service.start('ABCD-2345', true);
  assert.equal(service.pendingCount(), 1);
  const authorization = new URL(started.authorizationUrl);
  assert.equal(authorization.origin, 'https://auth.splcart.in');
  assert.equal(authorization.pathname, '/api/oidc/authorization');
  assert.equal(authorization.searchParams.get('client_id'), 'mecord-device-pairing-v1');
  assert.equal(authorization.searchParams.get('redirect_uri'), 'https://auth.splcart.in/pair/callback');
  assert.equal(authorization.searchParams.get('resource'), 'https://operator.splcart.in/mcp');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.match(authorization.searchParams.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.match(authorization.searchParams.get('state') ?? '', /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(started.authorizationUrl.includes('ABCD-2345'), false);

  const result = await service.complete({
    code: 'authorization-code',
    state: authorization.searchParams.get('state')
  });
  assert.deepEqual(result, { status: 'claimed', userCode: 'ABCD-2345', makeDefault: true });
  assert.equal(service.pendingCount(), 0);
  assert.equal(calls.length, 2);

  const tokenBody = new URLSearchParams(String(calls[0].init.body));
  assert.equal(tokenBody.get('grant_type'), 'authorization_code');
  assert.equal(tokenBody.get('client_id'), 'mecord-device-pairing-v1');
  assert.equal(tokenBody.get('redirect_uri'), 'https://auth.splcart.in/pair/callback');
  assert.match(tokenBody.get('code_verifier') ?? '', /^[A-Za-z0-9_-]{60,}$/);

  assert.equal(calls[1].init.method, 'POST');
  assert.equal((calls[1].init.headers as Record<string, string>).authorization, 'Bearer test-access-token-value');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { userCode: 'ABCD-2345', makeDefault: true });

  await assert.rejects(
    service.complete({ code: 'authorization-code-2', state: authorization.searchParams.get('state') }),
    /PAIR_STATE_INVALID/
  );

  now += 11 * 60_000;
  const expired = service.start('EFGH-6789');
  now += 11 * 60_000;
  await assert.rejects(
    service.complete({ code: 'authorization-code-3', state: new URL(expired.authorizationUrl).searchParams.get('state') }),
    /PAIR_STATE_INVALID/
  );
});

test('pairing callback consumes state even when token exchange fails', async () => {
  const service = createPairingService({
    fetchFn: async () => new Response(JSON.stringify({ error: 'invalid_grant' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    })
  });
  const started = service.start('JKLM-2345');
  const state = new URL(started.authorizationUrl).searchParams.get('state');
  await assert.rejects(service.complete({ code: 'bad-code', state }), /PAIR_TOKEN_EXCHANGE_FAILED/);
  await assert.rejects(service.complete({ code: 'bad-code', state }), /PAIR_STATE_INVALID/);
});

test('auth portal exposes only bounded Mecord pairing routes', () => {
  const source = text('deploy/auth-portal/server.mjs');
  const dockerfile = text('deploy/auth-portal/Dockerfile');
  const caddy = text('deploy/auth-portal/Caddyfile.auth-snippet.example');
  assert.match(source, /requestURL\.pathname === '\/pair'/);
  assert.match(source, /requestURL\.pathname === '\/pair\/start'/);
  assert.match(source, /requestURL\.pathname === '\/pair\/callback'/);
  assert.match(source, /pairRateAllowed\(ip\)/);
  assert.match(source, /pairing\.start\(payload\?\.userCode, payload\?\.makeDefault === true\)/);
  assert.match(source, /pairing\.complete\(\{ code, state \}\)/);
  assert.doesNotMatch(source, /if\(prefill\).*startPairing/);
  assert.match(source, /pairingClient=data\.client_id==='mecord-device-pairing-v1'/);
  assert.match(source, /Approve this computer/);
  assert.match(source, /Approve device/);
  assert.match(dockerfile, /COPY server\.mjs pairing\.mjs \./);
  assert.match(caddy, /@mecord_ui path \/signup \/signup\/\* \/recover \/pair \/pair\/\*/);
  assert.match(caddy, /@authelia_backend path \/api\/\* \/\.well-known\/\* \/jwks\.json/);
});

test('public edge pairing endpoint requires write scope and derives account from verified principal', () => {
  const source = text('apps/mcp-server/src/server.ts');
  assert.match(source, /app\.post\('\/pair\/api\/claim'/);
  assert.match(source, /requiredScopes: \[publicEdge\.writeScope\]/);
  assert.match(source, /principalFromAuthInfo\(authInfo, publicEdge\.publicUrl\)/);
  assert.match(source, /new LocalAgentClient\(agentUrl, agentToken, principal\)/);
  assert.match(source, /agent\.claimDevice\(userCode, body\?\.makeDefault === true\)/);
  assert.doesNotMatch(source, /body\?\.accountId/);
});

test('pairing OAuth client is isolated from ChatGPT redirect URIs', () => {
  const policy = text('deploy/auth-portal/authelia-oidc-policy.example.yml');
  assert.match(policy, /client_id: 'mecord-device-pairing-v1'/);
  assert.match(policy, /client_name: 'Mecord Device Pairing'/);
  assert.match(policy, /redirect_uris:[\s\S]*https:\/\/auth\.splcart\.in\/pair\/callback/);
  assert.match(policy, /require_pkce: true/);
  assert.match(policy, /pkce_challenge_method: 'S256'/);
  assert.match(policy, /token_endpoint_auth_method: 'none'/);
});

test('mecord runtime advertises direct secure pairing URL', () => {
  const cli = text('packages/mecord-connect/src/cli.mjs');
  const agent = text('apps/local-agent/src/main.ts');
  assert.match(cli, /const PAIR_URL_BASE = 'https:\/\/auth\.splcart\.in\/pair'/);
  assert.match(cli, /env\.OPERATOR_PAIR_URL_BASE = PAIR_URL_BASE/);
  assert.match(agent, /OPERATOR_PAIR_URL_BASE/);
  assert.match(agent, /pair this device:/);
  assert.match(agent, /url\.searchParams\.set\('code', userCode\)/);
});
