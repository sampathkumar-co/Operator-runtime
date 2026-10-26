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
