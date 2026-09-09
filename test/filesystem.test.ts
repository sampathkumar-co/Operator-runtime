import assert from 'node:assert/strict';
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

test('expected SHA prevents lost update', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-fs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'state.txt');
  await fs.writeFile(filePath, 'v1');
  const provider = new FilesystemProvider({ allowedRoots: [root] });

  const result = await provider.execute(action('file.write', { path: filePath, content: 'v2', expectedSha256: 'deadbeef' }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'PRECONDITION_FAILED');
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
