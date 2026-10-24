import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectInspectProvider } from '../src/capabilities/project.ts';
import type { ActionRequest } from '../src/core/types.ts';

async function fixture(t: test.TestContext) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-project-metadata-scope-'));
  const root = path.join(base, 'authorized');
  const outside = path.join(base, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { root, outside, provider: new ProjectInspectProvider({
    allowedRoots: [root], windowsPathLeaseExecutable: process.env.OPERATOR_WINDOWS_PATH_LEASE_PATH
  }) };
}
function inspect(root: string): ActionRequest {
  return {
    id: 'project-scope-synthetic',
    capability: 'project.inspect', risk: 'read',
    input: { path: root }, provenance: { kind: 'runtime' }
  };
}
async function symlinkOrSkip(t: test.TestContext, target: string, link: string): Promise<boolean> {
  try {
    await fs.symlink(target, link, 'file');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('The runner does not permit creating file symlinks.');
      return false;
    }
    throw error;
  }
}
function isDenied(error: any): boolean {
  return ['PATH_OUTSIDE_SCOPE', 'WINDOWS_PATH_LEASE_DENIED'].includes(error?.code);
}

test('project.inspect refuses package.json symlink to an unauthorized directory', async t => {
  const { root, outside, provider } = await fixture(t);
  const secret = 'EXTERNAL-SCRIPT-SECRET-DO-NOT-RETURN';
  const external = path.join(outside, 'sensitive-package.json');
  await fs.writeFile(external, JSON.stringify({ scripts: { external: secret } }));
  if (!await symlinkOrSkip(t, external, path.join(root, 'package.json'))) return;
  await assert.rejects(() => provider.execute(inspect(root)), isDenied);
  assert.equal(JSON.parse(await fs.readFile(external, 'utf8')).scripts.external, secret);
});

test('project.inspect refuses pyproject.toml symlink to an unauthorized directory', async t => {
  const { root, outside, provider } = await fixture(t);
  const external = path.join(outside, 'sensitive-pyproject.toml');
  await fs.writeFile(external, 'OUTSIDE-PROJECT-METADATA-SECRET');
  if (!await symlinkOrSkip(t, external, path.join(root, 'pyproject.toml'))) return;
  await assert.rejects(() => provider.execute(inspect(root)), isDenied);
});

test('large package.json is rejected before unbounded parsing', async t => {
  const { root, provider } = await fixture(t);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { huge: 'x'.repeat(4 * 1024 * 1024 + 10) }
  }));
  await assert.rejects(
    () => provider.execute(inspect(root)),
    (error: any) => error?.code === 'PROJECT_MANIFEST_TOO_LARGE'
  );
});

test('normal manifests continue returning trusted in-root scripts', async t => {
  const { root, provider } = await fixture(t);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { lint: 'node ./scripts/lint.mjs' }
  }));
  await fs.writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "fixture"\n');
  const result = await provider.execute(inspect(root));
  assert.equal(result.ok, true);
  assert.deepEqual((result.output as any).scripts, { lint: 'node ./scripts/lint.mjs' });
  assert.equal((result.output as any).pyprojectDetected, true);
});

test('malformed in-root package remains absent metadata instead of revealing external data', async t => {
  const { root, provider } = await fixture(t);
  await fs.writeFile(path.join(root, 'package.json'), '{ invalid-json');
  const result = await provider.execute(inspect(root));
  assert.equal(result.ok, true);
  assert.equal((result.output as any).scripts, null);
});
