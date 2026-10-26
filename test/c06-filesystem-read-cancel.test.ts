import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FilesystemProvider } from '../src/capabilities/filesystem.ts';

test('C06 pre-cancelled filesystem requests do not execute reads or writes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-c06-fs-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'demo.txt');
  await fs.writeFile(file, 'stable content');
  let leaseCalls = 0;
  const provider = new FilesystemProvider({
    allowedRoots: [root],
    pathLeaseHook: () => { leaseCalls++; }
  });
  const controller = new AbortController();
  controller.abort();
  for (const item of [
    { capability: 'file.read', risk: 'read', input: { path: file } },
    { capability: 'file.list', risk: 'read', input: { path: root } },
    { capability: 'file.info', risk: 'read', input: { path: file } },
    { capability: 'file.search', risk: 'read', input: { path: root, query: 'demo' } },
    { capability: 'file.create', risk: 'write', input: { path: path.join(root, 'new.txt'), content: 'unauthorized' } }
  ]) {
    const result = await provider.execute({
      id: 'aborted-' + item.capability, ...item,
      risk: item.risk as 'read' | 'write',
      provenance: { kind: 'runtime' }
    }, { signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'EXECUTION_ABORTED');
    assert.equal(result.error?.executionPhase, 'pre_dispatch');
    assert.equal(result.error?.sideEffectState, 'none');
  }
  assert.equal(leaseCalls, 0);
  assert.equal(await fs.readFile(file, 'utf8'), 'stable content');
  await assert.rejects(fs.stat(path.join(root, 'new.txt')), { code: 'ENOENT' });
});

test('C06 Stop during scoped filesystem read refuses a stale successful observation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-c06-fs-stop-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'file.txt');
  await fs.writeFile(file, 'unchanged');
  const controller = new AbortController();
  const provider = new FilesystemProvider({
    allowedRoots: [root],
    pathLeaseHook: () => controller.abort()
  });
  const result = await provider.execute({
    id: 'abort-after-scope', capability: 'file.read', risk: 'read',
    input: { path: file, maxBytes: 1024 }, provenance: { kind: 'runtime' }
  }, { signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'EXECUTION_ABORTED');
  assert.equal(result.error?.sideEffectState, 'none');
});

test('C06 recursive search refuses child directory replaced with a symlink after enumeration', async (t) => {
  if (process.platform === 'win32') return t.skip('native junction and path-lease race is separately Windows-certified');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-c06-search-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-c06-search-external-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, 'descend'));
  await fs.writeFile(path.join(outside, 'private-target.txt'), 'sensitive external fixture');
  const original = fs.readdir;
  let switched = false;
  fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => {
    const values = await (original as any)(...args);
    if (String(args[0]) === root && !switched) {
      switched = true;
      await fs.rename(path.join(root, 'descend'), path.join(root, 'old-descend'));
      await fs.symlink(outside, path.join(root, 'descend'), 'dir');
    }
    return values;
  }) as typeof fs.readdir;
  t.after(() => { fs.readdir = original; });
  const provider = new FilesystemProvider({ allowedRoots: [root] });
  const result = await provider.execute({
    id: 'search-symlink-redirect', capability: 'file.search', risk: 'read',
    input: { path: root, query: 'private-target', maxDepth: 4 },
    provenance: { kind: 'runtime' }
  });
  assert.equal(switched, true);
  assert.equal(result.ok, false, 'A child redirected outside scope cannot be silently enumerated.');
  assert.equal(result.error?.code, 'PATH_OUTSIDE_SCOPE');
  assert.equal(JSON.stringify(result).includes('private-target.txt'), false);
});

test('C06 recursive search rejects file replaced with a symlink before stat', async (t) => {
  if (process.platform === 'win32') return t.skip('native Windows symlink privilege and path-lease race certified separately');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-c06-search-file-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-c06-search-file-external-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); });
  const target = path.join(root, 'find-item.txt');
  await fs.writeFile(target, 'normal');
  await fs.writeFile(path.join(outside, 'private'), 'external fixture');
  const original = fs.readdir;
  let switched = false;
  fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => {
    const values = await (original as any)(...args);
    if (String(args[0]) === root && !switched) {
      switched = true;
      await fs.rm(target);
      await fs.symlink(path.join(outside, 'private'), target);
    }
    return values;
  }) as typeof fs.readdir;
  t.after(() => { fs.readdir = original; });
  const provider = new FilesystemProvider({ allowedRoots: [root] });
  const result = await provider.execute({
    id: 'search-swapped-file', capability: 'file.search', risk: 'read',
    input: { path: root, query: 'find-item', maxDepth: 1 },
    provenance: { kind: 'runtime' }
  });
  assert.equal(switched, true);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'FILE_SEARCH_ENTRY_CHANGED');
});
