import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readRelaySessionTokenFile } from '../apps/local-agent/src/relay-agent.ts';

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return await fs.realpath(dir);
}

async function makeSymlinkOrSkip(t: test.TestContext, target: string, link: string): Promise<boolean> {
  try {
    await fs.symlink(target, link, 'file');
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      t.skip(`symlink creation is unavailable on this runner (${code})`);
      return false;
    }
    throw error;
  }
}

const TOKEN = `${'a'.repeat(32)}.${'b'.repeat(32)}`;

test('relay session token reader accepts a bounded regular token file', async (t) => {
  const root = await tempDir(t, 'operator-relay-token-valid-');
  const file = path.join(root, 'relay-session.token');
  await fs.writeFile(file, `${TOKEN}\n`, { mode: 0o600 });

  assert.equal(await readRelaySessionTokenFile(file), TOKEN);
});

test('relay session token reader refuses a symlinked credential file', async (t) => {
  const root = await tempDir(t, 'operator-relay-token-link-');
  const outside = await tempDir(t, 'operator-relay-token-link-outside-');
  const target = path.join(outside, 'token.txt');
  await fs.writeFile(target, `${TOKEN}\n`, { mode: 0o600 });
  const link = path.join(root, 'relay-session.token');
  if (!(await makeSymlinkOrSkip(t, target, link))) return;

  await assert.rejects(
    () => readRelaySessionTokenFile(link),
    (error: any) => error?.code === 'RELAY_SESSION_TOKEN_FILE_INVALID'
  );
  assert.equal(await fs.readFile(target, 'utf8'), `${TOKEN}\n`);
});

test('relay session token reader refuses hard-linked credential files', async (t) => {
  const root = await tempDir(t, 'operator-relay-token-hardlink-');
  const outside = await tempDir(t, 'operator-relay-token-hardlink-outside-');
  const target = path.join(outside, 'token.txt');
  await fs.writeFile(target, `${TOKEN}\n`, { mode: 0o600 });
  const linked = path.join(root, 'relay-session.token');
  try {
    await fs.link(target, linked);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'EXDEV') {
      t.skip(`hard-link creation is unavailable on this runner (${code})`);
      return;
    }
    throw error;
  }

  await assert.rejects(
    () => readRelaySessionTokenFile(linked),
    (error: any) => error?.code === 'RELAY_SESSION_TOKEN_FILE_INVALID'
  );
  assert.ok((await fs.lstat(linked)).nlink > 1);
});

test('relay session token reader distinguishes missing files from malformed token content', async (t) => {
  const root = await tempDir(t, 'operator-relay-token-invalid-');
  const missing = path.join(root, 'missing.token');
  await assert.rejects(
    () => readRelaySessionTokenFile(missing),
    (error: any) => error?.code === 'RELAY_SESSION_TOKEN_FILE_MISSING'
  );

  const malformed = path.join(root, 'malformed.token');
  await fs.writeFile(malformed, 'not-a-valid-session-token', { mode: 0o600 });
  await assert.rejects(
    () => readRelaySessionTokenFile(malformed),
    (error: any) => error?.code === 'RELAY_SESSION_TOKEN_INVALID'
  );
});

test('relay session token reader rejects oversized credential files before parsing', async (t) => {
  const root = await tempDir(t, 'operator-relay-token-large-');
  const file = path.join(root, 'relay-session.token');
  await fs.writeFile(file, 'x'.repeat(16 * 1024 + 1), { mode: 0o600 });

  await assert.rejects(
    () => readRelaySessionTokenFile(file),
    (error: any) => error?.code === 'RELAY_SESSION_TOKEN_FILE_INVALID'
  );
});
