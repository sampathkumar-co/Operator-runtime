import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const portalRoot = resolve('deploy/auth-portal');
const secret = 'test-only-signup-challenge-secret-32-bytes';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
  return port;
}

async function startPortal(options: {
  dir: string;
  maxUsers?: number;
  trustedProxyIps?: string;
}): Promise<{ child: ChildProcess; origin: string }> {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: portalRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      PORTAL_SIGNUP_MODE: 'open',
      PORTAL_DEFAULT_GROUP: 'operator-users',
      PORTAL_CHALLENGE_SECRET: secret,
      PORTAL_CHALLENGE_MIN_AGE_MS: '0',
      PORTAL_TRUSTED_PROXY_IPS: options.trustedProxyIps ?? '127.0.0.1',
      PORTAL_MAX_USERS: String(options.maxUsers ?? 100),
      PORTAL_USERS_FILE: join(options.dir, 'users.yml'),
      PORTAL_SECURITY_STATE_FILE: join(options.dir, 'signup-security.json')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      const stderr = await new Promise<string>((resolveOutput) => {
        let output = '';
        child.stderr?.on('data', (chunk) => { output += String(chunk); });
        setTimeout(() => resolveOutput(output), 10);
      });
      throw new Error(`portal exited early (${child.exitCode}): ${stderr}`);
    }
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return { child, origin };
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  child.kill();
  throw new Error('portal did not become healthy');
}

async function stopPortal(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise<void>((resolveStopped) => child.once('exit', () => resolveStopped()));
}

async function challenge(origin: string, ip: string): Promise<string> {
  const response = await fetch(`${origin}/signup/challenge`, { headers: { 'x-real-ip': ip } });
  assert.equal(response.status, 200);
  return String((await response.json() as { token?: string }).token || '');
}

async function signup(origin: string, ip: string, body: Record<string, unknown>): Promise<Response> {
  return await fetch(`${origin}/signup/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify({ ...body, challenge: await challenge(origin, ip) })
  });
}

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mecord-auth-portal-'));
  await writeFile(join(dir, 'users.yml'), 'users: {}\n', { mode: 0o600 });
  return dir;
}

test('open signup has four visible fields and one client cannot lock out another', async () => {
  const dir = await fixture();
  const { child, origin } = await startPortal({ dir });
  try {
    const page = await (await fetch(`${origin}/signup`)).text();
    assert.deepEqual(
      [...page.matchAll(/<input id="(signup[^"]+)"/g)].map((match) => match[1]),
      ['signupUsername', 'signupEmail', 'signupPassword', 'signupConfirm']
    );
    assert.doesNotMatch(page, /Registration code/);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await signup(origin, '203.0.113.10', { username: 'x', email: 'bad', password: 'short' });
      assert.equal(response.status, 400);
    }
    assert.equal((await signup(origin, '203.0.113.10', { username: 'x', email: 'bad', password: 'short' })).status, 429);
    assert.equal((await signup(origin, '203.0.113.11', { username: 'x', email: 'bad', password: 'short' })).status, 400);

    const boundToken = await challenge(origin, '203.0.113.30');
    const mismatched = await fetch(`${origin}/signup/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.31' },
      body: JSON.stringify({ username: 'normaluser', email: 'normal@example.com', password: 'correct horse battery staple', challenge: boundToken })
    });
    assert.equal(mismatched.status, 400);
  } finally {
    await stopPortal(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test('untrusted forwarding is ignored and the per-client limit survives restart', async () => {
  const dir = await fixture();
  let running = await startPortal({ dir, trustedProxyIps: '192.0.2.200' });
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await signup(running.origin, `203.0.113.${attempt + 1}`, { username: 'x', email: 'bad', password: 'short' });
      assert.equal(response.status, 400);
    }
    await stopPortal(running.child);
    running = await startPortal({ dir, trustedProxyIps: '192.0.2.200' });
    const response = await signup(running.origin, '198.51.100.9', { username: 'x', email: 'bad', password: 'short' });
    assert.equal(response.status, 429);
  } finally {
    await stopPortal(running.child);
    await rm(dir, { recursive: true, force: true });
  }
});

test('open mode fails closed when required production safeguards are missing', async () => {
  const dir = await fixture();
  const port = await freePort();
  const env = { ...process.env };
  delete env.PORTAL_MAX_USERS;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: portalRoot,
    env: {
      ...env,
      PORT: String(port),
      PORTAL_SIGNUP_MODE: 'open',
      PORTAL_DEFAULT_GROUP: 'operator-users',
      PORTAL_CHALLENGE_SECRET: secret,
      PORTAL_TRUSTED_PROXY_IPS: '127.0.0.1',
      PORTAL_USERS_FILE: join(dir, 'users.yml')
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const [code] = await once(child, 'exit');
  assert.notEqual(code, 0);
  assert.match(stderr, /OPEN_SIGNUP_REQUIRES_MAX_USERS/);
  await rm(dir, { recursive: true, force: true });
});

test('the authoritative user cap admits only one concurrent final-slot signup', async () => {
  const dir = await fixture();
  await writeFile(join(dir, 'users.yml'), "users:\n  existing:\n    disabled: false\n    displayname: existing\n    password: '$argon2id$existing'\n    email: existing@example.com\n    groups:\n      - operator-users\n", { mode: 0o600 });
  const { child, origin } = await startPortal({ dir, maxUsers: 2 });
  try {
    const [first, second] = await Promise.all([
      signup(origin, '203.0.113.21', { username: 'normalone', email: 'one@example.com', password: 'correct horse battery staple' }),
      signup(origin, '203.0.113.22', { username: 'normaltwo', email: 'two@example.com', password: 'correct horse battery staple' })
    ]);
    assert.deepEqual([first.status, second.status].sort((a, b) => a - b), [201, 503]);
    const stored = await readFile(join(dir, 'users.yml'), 'utf8');
    assert.equal((stored.match(/^  [a-z0-9][a-z0-9._-]*:$/gm) || []).length, 2);
    assert.equal((stored.match(/^      - operator-users$/gm) || []).length, 2);
    assert.doesNotMatch(stored, /operator:developer|operator-admins|device-management/);
  } finally {
    await stopPortal(child);
    await rm(dir, { recursive: true, force: true });
  }
});

