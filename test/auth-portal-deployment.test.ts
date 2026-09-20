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

test('public signup surface stays isolated to explicit signup routes', () => {
  const source = text('deploy/auth-portal/server.mjs');
  assert.match(source, /req\.method === 'GET' && req\.url === '\/signup'/);
  assert.match(source, /req\.method === 'POST' && req\.url === '\/signup\/api'/);
  assert.match(source, /if \(!rateAllowed\(ip\)\) return send\(res, 429, \{ ok: false, error: 'Too many attempts\. Try again later\.' \}\);/);
  assert.match(source, /cache-control/);
  assert.match(source, /x-frame-options/);
});
