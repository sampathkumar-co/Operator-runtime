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

test('equivalent project-relative path forms stay canonical and create-list-read is immediately fresh', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-fs-canonical-'));
  await fs.mkdir(path.join(root, 'src'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new FilesystemProvider({ allowedRoots: [root] });

  const created = await provider.execute(action('file.create', { path: 'src/fresh.txt', content: 'fresh-now' }));
  assert.equal(created.ok, true, created.error?.message);

  const directoryForms = process.platform === 'win32'
    ? ['src', './src', '.\\src']
    : ['src', './src'];
  for (const form of directoryForms) {
    const listed = await provider.execute(action('file.list', { path: form }));
    assert.equal(listed.ok, true, `${form}: ${listed.error?.code ?? 'ok'}`);
    assert.equal((listed.output as any).entries.some((entry: any) => entry.name === 'fresh.txt'), true, form);
  }

  const expectedFile = await fs.realpath(path.join(root, 'src', 'fresh.txt'));
  const fileForms = process.platform === 'win32'
    ? ['src/fresh.txt', './src/fresh.txt', '.\\src\\fresh.txt']
    : ['src/fresh.txt', './src/fresh.txt'];
  for (const form of fileForms) {
    const read = await provider.execute(action('file.read', { path: form }));
    assert.equal(read.ok, true, `${form}: ${read.error?.code ?? 'ok'}`);
    assert.equal((read.output as any).path, expectedFile);
    assert.equal((read.output as any).content, 'fresh-now');
  }

  const escaped = await provider.execute(action('file.read', { path: '..\\outside.txt' }));
  assert.equal(escaped.ok, false);
  assert.equal(escaped.error?.code, 'PATH_OUTSIDE_SCOPE');
});
