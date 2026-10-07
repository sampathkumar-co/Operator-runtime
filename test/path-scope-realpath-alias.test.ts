import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PathScope } from '../src/capabilities/path-scope.ts';

test('POSIX scoped authority accepts the same root through a realpath alias but still rejects outside paths', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX realpath alias semantics'); return; }
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-path-alias-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const realRoot = path.join(parent, 'real-root');
  const aliasRoot = path.join(parent, 'alias-root');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(realRoot);
  await fs.mkdir(outside);
  await fs.symlink(realRoot, aliasRoot, 'dir');
  const file = path.join(realRoot, 'inside.txt');
  await fs.writeFile(file, 'inside');

  const scope = new PathScope([aliasRoot]);
  assert.equal(await scope.resolveExisting(file), await fs.realpath(file));
  assert.equal(await scope.withExisting(file, async (resolved) => resolved), await fs.realpath(file));
  assert.equal(
    await scope.withForWrite(path.join(realRoot, 'new.txt'), async (resolved) => resolved),
    path.join(await fs.realpath(realRoot), 'new.txt')
  );

  await assert.rejects(
    () => scope.withExisting(path.join(outside, 'missing.txt'), async () => undefined),
    (error: any) => error?.code === 'PATH_OUTSIDE_SCOPE' || error?.code === 'ENOENT'
  );
});
