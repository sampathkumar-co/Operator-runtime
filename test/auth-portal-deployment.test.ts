import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function text(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
}

test('auth signup portal uses pinned non-root production dependencies', () => {
  const dockerfile = text('deploy/auth-portal/Dockerfile');
  const pkg = JSON.parse(text('deploy/auth-portal/package.json')) as { dependencies?: Record<string, string> };
  assert.match(dockerfile, /^FROM node:22\.23\.2-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85$/m);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.equal(pkg.dependencies?.['@node-rs/argon2'], '2.2.1');
  assert.equal(pkg.dependencies?.yaml, '2.9.1');
});

test('auth signup portal hashes passwords in-process with production Argon2id parameters', () => {
  const source = text('deploy/auth-portal/server.mjs');
  assert.match(source, /Algorithm\.Argon2id/);
  assert.match(source, /memoryCost:\s*65536/);
  assert.match(source, /timeCost:\s*3/);
  assert.match(source, /parallelism:\s*4/);
  assert.match(source, /outputLen:\s*32/);
  assert.doesNotMatch(source, /--password|spawn\(|exec\(|execFile\(/);
  assert.doesNotMatch(source, /console\.log\([^\n]*password|console\.error\([^\n]*password/);
});

test('auth signup portal protects account creation and writes only normal users', () => {
  const source = text('deploy/auth-portal/server.mjs');
  assert.match(source, /PORTAL_INVITE_SHA256/);
  assert.match(source, /timingSafeEqual/);
  assert.match(source, /return item\.count <= 8/);
  assert.match(source, /Password must be 12-128 characters/);
  assert.match(source, /Enter a valid email address/);
  assert.match(source, /That username already exists/);
  assert.match(source, /That email is already in use/);
  assert.match(source, /const defaultGroup = process\.env\.PORTAL_DEFAULT_GROUP \|\| 'operator-users'/);
  assert.match(source, /groups: \[defaultGroup\]/);
  assert.doesNotMatch(source, /operator-admins/);
});

test('auth signup portal serializes writes and uses atomic replacement with backup', () => {
  const source = text('deploy/auth-portal/server.mjs');
  assert.match(source, /let writeQueue = Promise\.resolve\(\)/);
  assert.match(source, /writeQueue\.then\(\(\) => createUser\(payload\)\)/);
  assert.match(source, /\.portal-backup/);
  assert.match(source, /\.portal-tmp/);
  assert.match(source, /fs\.rename\(temp, usersFile\)/);
});

test('public auth surface exposes signup plus the OpenID Connect entry only', () => {
  const source = text('deploy/auth-portal/server.mjs');
  assert.match(source, /requestURL\.pathname === '\/' && requestURL\.searchParams\.get\('flow'\) === 'openid_connect'/);
  assert.match(source, /requestURL\.pathname === '\/signup' \|\| requestURL\.pathname === '\/recover' \|\| oauthEntry/);
  assert.match(source, /req\.method === 'POST' && req\.url === '\/signup\/api'/);
  assert.match(source, /if \(!rateAllowed\(ip\)\) return send\(res, 429, \{ ok: false, error: 'Too many attempts\. Try again later\.' \}\);/);
  assert.match(source, /cache-control/);
  assert.match(source, /x-frame-options/);
});

test('OAuth login page preserves Authelia flow fields and resumes stored consent if the first-factor response omits a redirect', () => {
  const source = text('deploy/auth-portal/server.mjs');
  assert.match(source, /fetch\('\/api\/firstfactor'/);
  for (const field of ['rd', 'rm', 'flow_id', 'flow', 'subflow', 'user_code']) {
    assert.match(source, new RegExp("q\\.get\\('" + field.replace('_', '\\_') + "'\\)"));
  }
  assert.match(source, /keepMeLoggedIn:byId\('remember'\)\.checked/);
  assert.match(source, /\/api\/oidc\/authorization\?consent_id=/);
  assert.match(source, /encodeURIComponent\(flowID\)/);
  assert.match(source, /location\.assign\('\/recover'\)/);
  assert.doesNotMatch(source, /auth_native/);
  assert.match(source, /Account created\. Sign in to continue\./);
});

test('public auth routing exposes Mecord pages and only machine-facing Authelia endpoints', () => {
  const caddy = text('deploy/auth-portal/Caddyfile.auth-snippet.example');
  assert.match(caddy, /query flow=openid_connect/);
  assert.match(caddy, /@mecord_ui path \/signup \/signup\/\* \/recover/);
  assert.match(caddy, /@authelia_backend path \/api\/\* \/\.well-known\/\* \/jwks\.json/);
  assert.ok(caddy.includes('redir * /recover 303'));
  assert.match(caddy, /reverse_proxy 172\.16\.3\.31:8090/);
  assert.match(caddy, /reverse_proxy 172\.16\.3\.30:9091/);
  assert.ok(caddy.indexOf('@oauth_entry') < caddy.indexOf('@authelia_backend'));
  assert.ok(caddy.indexOf('@authelia_backend') < caddy.lastIndexOf('handle {'));
});

test('OAuth entry renders Mecord product UI rather than raw Authelia branding', () => {
  const source = text('deploy/auth-portal/server.mjs');
  assert.match(source, /Mecord Connect/);
  assert.match(source, /Your computer, available to ChatGPT\./);
  assert.match(source, /Create account/);
  assert.match(source, /Sign in/);
  assert.doesNotMatch(source, /Powered by Authelia/);
});

test('all non-backend Authelia browser routes are removed from the public surface', () => {
  const source = text('deploy/auth-portal/server.mjs');
  const caddy = text('deploy/auth-portal/Caddyfile.auth-snippet.example');
  assert.match(source, /requestURL\.pathname === '\/recover'/);
  assert.match(source, /This connection is no longer valid\. Return to ChatGPT and click Connect again\./);
  assert.match(caddy, /@authelia_backend path \/api\/\* \/\.well-known\/\* \/jwks\.json/);
  assert.match(caddy, /Any other browser\/page route is intentionally hidden/);
  assert.ok(caddy.includes('redir * /recover 303'));
  assert.doesNotMatch(caddy, /auth_native/);
});

test('Mecord groups stay one-factor while unrelated accounts retain the stronger fallback', () => {
  const policy = text('deploy/auth-portal/authelia-oidc-policy.example.yml');
  assert.match(policy, /default_policy: 'two_factor'/);
  assert.match(policy, /subject: 'group:operator-users'/);
  assert.match(policy, /subject: 'group:operator-reviewers'/);
  assert.match(policy, /consent_mode: 'implicit'/);
  assert.match(policy, /client_name: 'Mecord Connect'/);
  assert.match(policy, /require_pkce: true/);
});
