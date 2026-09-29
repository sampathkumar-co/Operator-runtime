import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FilesystemProvider } from '../src/capabilities/filesystem.ts';

function action(capability: string, input: Record<string, unknown>) {
  return { id: crypto.randomUUID(), capability, risk: capability === 'file.write' ? 'write' as const : 'read' as const, input, provenance: { kind: 'chatgpt' as const } };
}

test('filesystem provider performs atomic write/read with SHA postcondition', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-fs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new FilesystemProvider({ allowedRoots: [root] });
  const filePath = path.join(root, 'hello.txt');

  const write = await provider.execute(action('file.write', { path: filePath, content: 'hello operator' }));
  assert.equal(write.ok, true);
  assert.equal((write.output as { bytes: number }).bytes, 14);

  const read = await provider.execute(action('file.read', { path: filePath }));
  assert.equal(read.ok, true);
  assert.equal((read.output as { content: string }).content, 'hello operator');
  assert.equal((read.output as { sha256: string }).sha256, (write.output as { afterSha256: string }).afterSha256);
});


test('write reports a missing parent explicitly instead of a generic path-lease failure', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-fs-missing-parent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new FilesystemProvider({ allowedRoots: [root] });
  const target = path.join(root, 'missing', 'nested.txt');

  const result = await provider.execute(action('file.write', { path: target, content: 'x' }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'PARENT_DIRECTORY_MISSING');
  await assert.rejects(fs.access(target));
});

test('expected SHA prevents lost update and accepts hexadecimal case differences', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-fs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'state.txt');
  await fs.writeFile(filePath, 'v1');
  const provider = new FilesystemProvider({ allowedRoots: [root] });

  const wrong = await provider.execute(action('file.write', { path: filePath, content: 'v2', expectedSha256: '0'.repeat(64) }));
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error?.code, 'PRECONDITION_FAILED');
  assert.equal(await fs.readFile(filePath, 'utf8'), 'v1');

  const digest = crypto.createHash('sha256').update('v1').digest('hex').toUpperCase();
  const correctUppercase = await provider.execute(action('file.write', { path: filePath, content: 'v2', expectedSha256: digest }));
  assert.equal(correctUppercase.ok, true);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'v2');
});

test('malformed expected SHA is rejected before write', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-fs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'state.txt');
  await fs.writeFile(filePath, 'v1');
  const provider = new FilesystemProvider({ allowedRoots: [root] });

  const result = await provider.execute(action('file.write', { path: filePath, content: 'v2', expectedSha256: 'deadbeef' }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'PRECONDITION_INVALID');
  assert.equal(await fs.readFile(filePath, 'utf8'), 'v1');
});

test('symlink escape is blocked at the local boundary', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-outside-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  const link = path.join(root, 'escape');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const provider = new FilesystemProvider({ allowedRoots: [root] });

  const result = await provider.execute(action('file.read', { path: path.join(link, 'secret.txt') }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, process.platform === 'win32' ? 'WINDOWS_PATH_LEASE_DENIED' : 'PATH_OUTSIDE_SCOPE');
});

test('write refuses an existing file symlink instead of reading or replacing its target', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-outside-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  const outsideFile = path.join(outside, 'secret.txt');
  await fs.writeFile(outsideFile, 'secret');
  const link = path.join(root, 'target.txt');
  try {
    await fs.symlink(outsideFile, link, 'file');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('Windows host does not grant file-symlink privilege.');
      return;
    }
    throw error;
  }

  const provider = new FilesystemProvider({ allowedRoots: [root] });
  const result = await provider.execute(action('file.write', { path: link, content: 'overwrite' }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'WRITE_SYMLINK_DENIED');
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'secret');
});

test('write has an intrinsic byte bound independent of HTTP/MCP body limits', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-fs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new FilesystemProvider({ allowedRoots: [root], maxWriteBytes: 4 });
  const filePath = path.join(root, 'bounded.txt');

  const result = await provider.execute(action('file.write', { path: filePath, content: '12345' }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'WRITE_TOO_LARGE');
  await assert.rejects(fs.access(filePath));
});

test('file.create is create-only and file.replace requires an exact fresh SHA', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-fs-safe-write-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new FilesystemProvider({ allowedRoots: [root] });
  const filePath = path.join(root, 'safe.txt');

  const created = await provider.execute(action('file.create', { path: filePath, content: 'v1' }));
  assert.equal(created.ok, true);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'v1');

  const overwrite = await provider.execute(action('file.create', { path: filePath, content: 'bad' }));
  assert.equal(overwrite.ok, false);
  assert.equal(overwrite.error?.code, 'TARGET_EXISTS');
  assert.equal(await fs.readFile(filePath, 'utf8'), 'v1');

  const noSha = await provider.execute(action('file.replace', { path: filePath, content: 'v2' }));
  assert.equal(noSha.ok, false);
  assert.equal(noSha.error?.code, 'PRECONDITION_REQUIRED');

  const stale = await provider.execute(action('file.replace', { path: filePath, content: 'v2', expectedSha256: '0'.repeat(64) }));
  assert.equal(stale.ok, false);
  assert.equal(stale.error?.code, 'PRECONDITION_FAILED');

  const sha = crypto.createHash('sha256').update('v1').digest('hex');
  const replaced = await provider.execute(action('file.replace', { path: filePath, content: 'v2', expectedSha256: sha }));
  assert.equal(replaced.ok, true);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'v2');
});

test('file.replace never overwrites a concurrent recreation after claiming the expected file', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-fs-cas-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'race.txt');
  await fs.writeFile(filePath, 'v1');
  const sha = crypto.createHash('sha256').update('v1').digest('hex');
  const provider = new FilesystemProvider({
    allowedRoots: [root],
    replaceClaimHook: async (claimedPath) => { await fs.writeFile(claimedPath, 'concurrent'); }
  });

  const result = await provider.execute(action('file.replace', {
    path: filePath, content: 'v2', expectedSha256: sha
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'PRECONDITION_FAILED');
  assert.equal(await fs.readFile(filePath, 'utf8'), 'concurrent');
  assert.equal((await fs.readdir(root)).some((name) => name.endsWith('.bak') || name.endsWith('.tmp')), false);
});


test('file.search recursively finds bounded matches without following symlinks', async (ctx) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-fs-search-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-fs-search-outside-'));
  ctx.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, 'src', 'nested'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'nested', 'needle-file.txt'), 'x');
  await fs.writeFile(path.join(outside, 'needle-secret.txt'), 'secret');
  try { await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); } catch {}
  const provider = new FilesystemProvider({ allowedRoots: [root] });
  const result = await provider.execute(action('file.search', { path: root, query: 'needle', maxDepth: 5, maxResults: 10 }));
  assert.equal(result.ok, true, result.error?.message);
  const paths = ((result.output as any).results as any[]).map((item) => item.path);
  assert.equal(paths.some((item) => item.endsWith('needle-file.txt')), true);
  assert.equal(paths.some((item) => item.includes('needle-secret.txt')), false);
});

test('file.info returns SHA and file.manage copy/move require safe preconditions', async (ctx) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-fs-manage-'));
  ctx.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new FilesystemProvider({ allowedRoots: [root] });
  const source = path.join(root, 'source.txt');
  const copy = path.join(root, 'copy.txt');
  const moved = path.join(root, 'moved.txt');
  await fs.writeFile(source, 'content');

  const info = await provider.execute(action('file.info', { path: source }));
  assert.equal(info.ok, true);
  const digest = (info.output as any).sha256 as string;
  assert.match(digest, /^[0-9a-f]{64}$/);

  const copied = await provider.execute({ ...action('file.manage', { operation: 'copy', source, destination: copy }), risk: 'write' });
  assert.equal(copied.ok, true, copied.error?.message);
  assert.equal(await fs.readFile(copy, 'utf8'), 'content');

  const staleMove = await provider.execute({ ...action('file.manage', { operation: 'move', source: copy, destination: moved, expectedSha256: '0'.repeat(64) }), risk: 'destructive' });
  assert.equal(staleMove.ok, false);
  assert.equal(staleMove.error?.code, 'PRECONDITION_FAILED');

  const copyDigest = crypto.createHash('sha256').update('content').digest('hex');
  const move = await provider.execute({ ...action('file.manage', { operation: 'move', source: copy, destination: moved, expectedSha256: copyDigest }), risk: 'destructive' });
  assert.equal(move.ok, true, move.error?.message);
  await assert.rejects(fs.access(copy));
  assert.equal(await fs.readFile(moved, 'utf8'), 'content');
});

test('file.manage mkdir and bounded remove preserve destructive safeguards', async (ctx) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-fs-remove-'));
  ctx.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new FilesystemProvider({ allowedRoots: [root] });
  const dir = path.join(root, 'new-dir');
  const made = await provider.execute({ ...action('file.manage', { operation: 'mkdir', path: dir }), risk: 'write' });
  assert.equal(made.ok, true, made.error?.message);

  const file = path.join(dir, 'item.txt');
  await fs.writeFile(file, 'v1');
  const wrong = await provider.execute({ ...action('file.manage', { operation: 'remove', path: file, expectedSha256: '0'.repeat(64) }), risk: 'destructive' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error?.code, 'PRECONDITION_FAILED');

  const digest = crypto.createHash('sha256').update('v1').digest('hex');
  const removed = await provider.execute({ ...action('file.manage', { operation: 'remove', path: file, expectedSha256: digest }), risk: 'destructive' });
  assert.equal(removed.ok, true, removed.error?.message);
  const removedDir = await provider.execute({ ...action('file.manage', { operation: 'remove', path: dir }), risk: 'destructive' });
  assert.equal(removedDir.ok, true, removedDir.error?.message);
});
