import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FilesystemProvider } from '../src/capabilities/filesystem.ts';

const helper = process.env.OPERATOR_WINDOWS_PATH_LEASE_PATH;

function requireWindows(t: test.TestContext): string | null {
  if (process.platform !== 'win32') {
    t.skip('Windows junction authority regression.');
    return null;
  }
  assert.ok(helper && path.isAbsolute(helper), 'OPERATOR_WINDOWS_PATH_LEASE_PATH must point to the built helper on Windows.');
  return helper;
}

function action(capability: string, input: Record<string, unknown>) {
  const risk = capability === 'file.replace' ? 'destructive'
    : capability === 'file.create' || capability === 'file.write' ? 'write' : 'read';
  return { id: crypto.randomUUID(), capability, risk, input, provenance: { kind: 'chatgpt' as const } };
}

async function fixture(t: test.TestContext, prefix: string) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');  await fs.mkdir(root);
  await fs.mkdir(outside);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, root, outside };
}

async function trySwapDirectory(safeDir: string, outside: string): Promise<{ swapped: boolean; error?: NodeJS.ErrnoException }> {
  const moved = `${safeDir}-moved`;
  try {
    await fs.rename(safeDir, moved);
    await fs.symlink(outside, safeDir, 'junction');
    return { swapped: true };
  } catch (error) {
    return { swapped: false, error: error as NodeJS.ErrnoException };
  }
}

test('Windows static junction read is denied before outside secret bytes are returned', async (t) => {
  const lease = requireWindows(t); if (!lease) return;
  const { root, outside } = await fixture(t, 'operator-junction-static-read-');
  const secret = 'OUTSIDE-SECRET-STATIC';
  await fs.writeFile(path.join(outside, 'secret.txt'), secret);
  const link = path.join(root, 'safe');
  await fs.symlink(outside, link, 'junction');
  const provider = new FilesystemProvider({ allowedRoots: [root], windowsPathLeaseExecutable: lease });
  const result = await provider.execute(action('file.read', { path: path.join(link, 'secret.txt') }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'WINDOWS_PATH_LEASE_DENIED');
  assert.doesNotMatch(JSON.stringify(result), /OUTSIDE-SECRET-STATIC/);
});
test('Windows static junction create is denied and outside bytes stay unchanged', async (t) => {
  const lease = requireWindows(t); if (!lease) return;
  const { root, outside } = await fixture(t, 'operator-junction-static-create-');
  const outsideFile = path.join(outside, 'new.txt');
  await fs.writeFile(outsideFile, 'OUTSIDE-ORIGINAL');
  const link = path.join(root, 'safe');
  await fs.symlink(outside, link, 'junction');
  const provider = new FilesystemProvider({ allowedRoots: [root], windowsPathLeaseExecutable: lease });
  const result = await provider.execute(action('file.create', { path: path.join(link, 'created.txt'), content: 'ATTACK' }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'WINDOWS_PATH_LEASE_DENIED');
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'OUTSIDE-ORIGINAL');
  await assert.rejects(fs.access(path.join(outside, 'created.txt')));
});

test('Windows static junction replace is denied and outside bytes stay unchanged', async (t) => {
  const lease = requireWindows(t); if (!lease) return;
  const { root, outside } = await fixture(t, 'operator-junction-static-replace-');
  const outsideFile = path.join(outside, 'target.txt');
  await fs.writeFile(outsideFile, 'OUTSIDE-ORIGINAL');
  const link = path.join(root, 'safe');
  await fs.symlink(outside, link, 'junction');
  const provider = new FilesystemProvider({ allowedRoots: [root], windowsPathLeaseExecutable: lease });
  const expectedSha256 = crypto.createHash('sha256').update('OUTSIDE-ORIGINAL').digest('hex');
  const result = await provider.execute(action('file.replace', {
    path: path.join(link, 'target.txt'), content: 'ATTACK', expectedSha256
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'WINDOWS_PATH_LEASE_DENIED');
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'OUTSIDE-ORIGINAL');
});

test('Windows junction insertion after validation cannot redirect file.read', async (t) => {
  const lease = requireWindows(t); if (!lease) return;
  const { root, outside } = await fixture(t, 'operator-junction-race-read-');
  const safeDir = path.join(root, 'safe');
  await fs.mkdir(safeDir);
  await fs.writeFile(path.join(safeDir, 'secret.txt'), 'INSIDE-SAFE');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'OUTSIDE-SECRET-RACE');
  let attack: Awaited<ReturnType<typeof trySwapDirectory>> | undefined;
  const provider = new FilesystemProvider({
    allowedRoots: [root], windowsPathLeaseExecutable: lease,
    pathLeaseHook: async () => { attack = await trySwapDirectory(safeDir, outside); }
  });  const result = await provider.execute(action('file.read', { path: path.join(safeDir, 'secret.txt') }));
  assert.equal(attack?.swapped, false);
  assert.ok(attack?.error, 'junction swap attempt must be denied by the held Windows lease');
  assert.equal(result.ok, true);
  assert.equal((result.output as { content: string }).content, 'INSIDE-SAFE');
  assert.doesNotMatch(JSON.stringify(result), /OUTSIDE-SECRET-RACE/);
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'OUTSIDE-SECRET-RACE');
});

test('Windows junction insertion after validation cannot redirect file.create', async (t) => {
  const lease = requireWindows(t); if (!lease) return;
  const { root, outside } = await fixture(t, 'operator-junction-race-create-');
  const safeDir = path.join(root, 'safe');
  await fs.mkdir(safeDir);
  const outsideFile = path.join(outside, 'new.txt');
  await fs.writeFile(outsideFile, 'OUTSIDE-ORIGINAL');
  let attack: Awaited<ReturnType<typeof trySwapDirectory>> | undefined;
  const provider = new FilesystemProvider({
    allowedRoots: [root], windowsPathLeaseExecutable: lease,
    pathLeaseHook: async () => { attack = await trySwapDirectory(safeDir, outside); }
  });
  const insideFile = path.join(safeDir, 'new.txt');
  const result = await provider.execute(action('file.create', { path: insideFile, content: 'INSIDE-CREATED' }));
  assert.equal(attack?.swapped, false);
  assert.ok(attack?.error, 'junction swap attempt must be denied by the held Windows lease');
  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(insideFile, 'utf8'), 'INSIDE-CREATED');
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'OUTSIDE-ORIGINAL');
});
test('Windows junction insertion after validation cannot redirect file.replace', async (t) => {
  const lease = requireWindows(t); if (!lease) return;
  const { root, outside } = await fixture(t, 'operator-junction-race-replace-');
  const safeDir = path.join(root, 'safe');
  await fs.mkdir(safeDir);
  const insideFile = path.join(safeDir, 'target.txt');
  const outsideFile = path.join(outside, 'target.txt');
  await fs.writeFile(insideFile, 'INSIDE-BEFORE');
  await fs.writeFile(outsideFile, 'OUTSIDE-BEFORE');
  const expectedSha256 = crypto.createHash('sha256').update('INSIDE-BEFORE').digest('hex');
  let attack: Awaited<ReturnType<typeof trySwapDirectory>> | undefined;
  const provider = new FilesystemProvider({
    allowedRoots: [root], windowsPathLeaseExecutable: lease,
    pathLeaseHook: async () => { attack = await trySwapDirectory(safeDir, outside); }
  });
  const result = await provider.execute(action('file.replace', {
    path: insideFile, content: 'INSIDE-AFTER', expectedSha256
  }));
  assert.equal(attack?.swapped, false);
  assert.ok(attack?.error, 'junction swap attempt must be denied by the held Windows lease');
  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(insideFile, 'utf8'), 'INSIDE-AFTER');
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'OUTSIDE-BEFORE');
});
