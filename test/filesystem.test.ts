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
  assert.equal(result.error?.code, 'PATH_OUTSIDE_SCOPE');
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
