import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FilesystemProvider } from '../src/capabilities/filesystem.ts';

function action(capability: string, input: Record<string, unknown>) {
  const risk = capability === 'file.create' ? 'write' as const : 'read' as const;
  return { id: crypto.randomUUID(), capability, risk, input, provenance: { kind: 'chatgpt' as const } };
}

test('relative create is immediately visible through normalized parent listings', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-fs-relative-'));
  await fs.mkdir(path.join(root, 'test'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new FilesystemProvider({ allowedRoots: [root] });

  const created = await provider.execute(action('file.create', {
    path: 'test/fresh.txt',
    content: 'fresh'
  }));
  assert.equal(created.ok, true);


  for (const relative of ['test/.', './test']) {
    const listed = await provider.execute(action('file.list', { path: relative }));
    assert.equal(listed.ok, true);
    const names = (listed.output as any).entries.map((entry: any) => entry.name);
    assert.ok(names.includes('fresh.txt'), `${relative} must include the newly created file`);
  }

  if (process.platform === 'win32') {
    for (const relative of ['test\\.', '.\\test']) {
      const listed = await provider.execute(action('file.list', { path: relative }));
      assert.equal(listed.ok, true);
      const names = (listed.output as any).entries.map((entry: any) => entry.name);
      assert.ok(names.includes('fresh.txt'), `${relative} must include the newly created file`);
    }
  }

  const escaped = await provider.execute(action('file.list', { path: '../' }));
  assert.equal(escaped.ok, false);
  assert.equal(escaped.error?.code, 'PATH_OUTSIDE_SCOPE');
});
