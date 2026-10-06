import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readDurableStateText, writeDurableStateText } from '../src/core/durable-state.ts';

const OPTIONS = {
  maxBytes: 1024 * 1024,
  errorCode: 'DURABLE_RACE_TEST_CORRUPT',
  invalidMessage: 'Durable race fixture is invalid.'
} as const;

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-durable-race-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('durable reads retry a transient link-topology race and return only after the path is singly linked again', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX hard-link topology race'); return; }
  const dir = await temp(t);
  const file = path.join(dir, 'state.json');
  const alias = path.join(dir, 'state.transient-link');
  await writeDurableStateText(file, '{"ok":true}', OPTIONS);
  await fs.link(file, alias);
  const before = await fs.lstat(file);
  assert.equal(before.nlink, 2);

  const cleanup = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      fs.rm(alias).then(() => resolve(), reject);
    }, 35);
    timer.unref?.();
  });

  const text = await readDurableStateText(file, OPTIONS);
  await cleanup;
  assert.equal(text, '{"ok":true}');
  assert.equal((await fs.lstat(file)).nlink, 1);
});

test('durable reads still fail closed when a hard link persists across the bounded retry window', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX hard-link topology test'); return; }
  const dir = await temp(t);
  const file = path.join(dir, 'state.json');
  const alias = path.join(dir, 'state.persistent-link');
  await writeDurableStateText(file, '{"ok":true}', OPTIONS);
  await fs.link(file, alias);

  await assert.rejects(
    () => readDurableStateText(file, OPTIONS),
    (error: any) => error?.code === 'DURABLE_RACE_TEST_CORRUPT'
      && /link topology changed|changed while it was being read|Hard-linked state files are not permitted/i.test(error?.message ?? '')
  );
  assert.equal((await fs.lstat(file)).nlink, 2);
});

test('durable writes never accept a hard-linked replacement target', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX hard-link topology test'); return; }
  const dir = await temp(t);
  const file = path.join(dir, 'state.json');
  const alias = path.join(dir, 'state.write-link');
  await writeDurableStateText(file, '{"version":1}', OPTIONS);
  await fs.link(file, alias);

  await assert.rejects(
    () => writeDurableStateText(file, '{"version":2}', OPTIONS),
    (error: any) => error?.code === 'DURABLE_RACE_TEST_CORRUPT'
      && /Hard-linked state files are not permitted/i.test(error?.message ?? '')
  );
  assert.equal(await fs.readFile(file, 'utf8'), '{"version":1}');
  assert.equal(await fs.readFile(alias, 'utf8'), '{"version":1}');
});
