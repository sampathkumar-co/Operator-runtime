import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SignJWT,
  exportJWK,
  generateKeyPair
} from 'jose';
import { OAuthJwtVerifier } from '../src/oauth-jwt.ts';

const issuer = 'https://auth.operator.dev/';
const resource = 'https://mcp.operator.dev/mcp';
const jwksUrl = new URL('https://auth.operator.dev/.well-known/jwks.json');

async function fixture() {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: 'operator-test-key', use: 'sig', alg: 'RS256' });
  let fetches = 0;
  const fetchFn = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    fetches += 1;
    assert.equal(init?.redirect, 'error');
    return Response.json({ keys: [jwk] });
  }) as typeof fetch;
  const verifier = new OAuthJwtVerifier({
    jwksUrl,
    issuer,
    audience: resource,
    resourceUrl: new URL(resource)
  }, { fetchFn });
  const sign = (overrides: { issuer?: string; audience?: string; exp?: boolean } = {}) => {
    let jwt = new SignJWT({ scope: 'operator:read operator:write', client_id: 'chatgpt-client' })
      .setProtectedHeader({ alg: 'RS256', kid: 'operator-test-key' })
      .setIssuer(overrides.issuer ?? issuer)
      .setAudience(overrides.audience ?? resource)
      .setSubject('user-123')
      .setIssuedAt();
    if (overrides.exp !== false) jwt = jwt.setExpirationTime('5m');
    return jwt.sign(privateKey);
  };
  return { verifier, sign, fetches: () => fetches };
}

test('JWT verifier validates RS256 signature, issuer, audience, expiry, and scopes through JWKS', async () => {
  const f = await fixture();
  const auth = await f.verifier.verifyAccessToken(await f.sign());
  assert.equal(auth.token, '');
  assert.equal(auth.clientId, 'chatgpt-client');
  assert.deepEqual(auth.scopes, ['operator:read', 'operator:write']);
  assert.equal(auth.resource?.toString(), resource);
  assert.deepEqual(auth.extra, { issuer, subject: 'user-123' });
  assert.equal(f.fetches(), 1);
});

test('JWT verifier rejects issuer, audience, and expiry drift', async () => {
  const f = await fixture();
  await assert.rejects(async () => f.verifier.verifyAccessToken(await f.sign({ issuer: 'https://other.operator.dev/' })), /invalid/i);
  await assert.rejects(async () => f.verifier.verifyAccessToken(await f.sign({ audience: 'https://other.operator.dev/mcp' })), /invalid/i);
  await assert.rejects(async () => f.verifier.verifyAccessToken(await f.sign({ exp: false })), /expiration/i);
});

test('JWT verifier rejects algorithm downgrade and cross-origin JWKS authority', async () => {
  const f = await fixture();
  const hs = await new SignJWT({ scope: 'operator:read', client_id: 'chatgpt-client' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(issuer)
    .setAudience(resource)
    .setSubject('user-123')
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'));
  await assert.rejects(() => f.verifier.verifyAccessToken(hs), /invalid/i);
  assert.throws(() => new OAuthJwtVerifier({
    jwksUrl: new URL('https://keys.evil.example/jwks.json'),
    issuer,
    audience: resource,
    resourceUrl: new URL(resource)
  }), /same origin/i);
});
