import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertMigrationCapabilities,
  buildMigrationArtifacts,
  migrationAuthorityDigest,
  verifyMigrationResourceKey
} from '../apps/local-agent/src/migration-proofs.ts';

async function temp(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('stage15 portable authority digest is stable across capability/resource ordering', () => {
  const a = migrationAuthorityDigest({
    requiredCapabilities: ['git.status', 'file.read'],
    resourceKeys: ['repo:/project', 'file:/project/a.txt']
  });
  const b = migrationAuthorityDigest({
    requiredCapabilities: ['file.read', 'git.status'],
    resourceKeys: ['file:/project/a.txt', 'repo:/project']
  });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('stage15 migration requires exact capabilities that are both authorized and supported locally', () => {
  const permissions = {
    allowedCapabilities: ['file.*', 'git.status'],
    allowedRoots: ['/project']
  };
  assert.deepEqual(assertMigrationCapabilities({
    requiredCapabilities: ['git.status', 'file.read'],
    permissions,
    supportedCapabilities: ['file.read', 'git.status']
  }), ['file.read', 'git.status']);

  assert.throws(() => assertMigrationCapabilities({
    requiredCapabilities: ['terminal.execute'],
    permissions,
    supportedCapabilities: ['terminal.execute']
  }), (error: any) => error?.code === 'SEMANTIC_MIGRATION_CAPABILITY_DENIED');

  assert.throws(() => assertMigrationCapabilities({
    requiredCapabilities: ['file.read'],
    permissions,
    supportedCapabilities: []
  }), (error: any) => error?.code === 'SEMANTIC_MIGRATION_CAPABILITY_UNAVAILABLE');

  assert.throws(() => assertMigrationCapabilities({
    requiredCapabilities: ['file.*'],
    permissions,
    supportedCapabilities: ['file.read']
  }), (error: any) => error?.code === 'SEMANTIC_MIGRATION_INPUT_INVALID');
});

test('stage15 resource proof resolves physical paths inside authorized roots and rejects escapes', async (t) => {
  const root = await temp(t, 'operator-migration-proof-root-');
  const outside = await temp(t, 'operator-migration-proof-outside-');
  const allowedFile = path.join(root, 'a.txt');
  const deniedFile = path.join(outside, 'secret.txt');
  await fs.writeFile(allowedFile, 'allowed');
  await fs.writeFile(deniedFile, 'denied');
  const permissions = { allowedCapabilities: ['file.read'], allowedRoots: [root] };

  assert.equal(await verifyMigrationResourceKey(`file:${allowedFile}`, permissions, ['file.read']), true);
  assert.equal(await verifyMigrationResourceKey(`file:${deniedFile}`, permissions, ['file.read']), false);
  assert.equal(await verifyMigrationResourceKey('browser:global', permissions, ['file.read']), false);
});

test('stage15 artifact digests are computed from real locally authorized bytes', async (t) => {
  const root = await temp(t, 'operator-migration-artifact-root-');
  const outside = await temp(t, 'operator-migration-artifact-outside-');
  const file = path.join(root, 'bundle.bin');
  const denied = path.join(outside, 'denied.bin');
  await fs.writeFile(file, Buffer.from('migration-artifact'));
  await fs.writeFile(denied, Buffer.from('outside'));

  const artifacts = await buildMigrationArtifacts(
    [{ key: 'bundle', path: file }],
    { allowedCapabilities: ['file.read'], allowedRoots: [root] }
  );
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]!.size, Buffer.byteLength('migration-artifact'));
  assert.match(artifacts[0]!.digest, /^[0-9a-f]{64}$/);

  await assert.rejects(
    () => buildMigrationArtifacts([{ key: 'denied', path: denied }], { allowedCapabilities: ['file.read'], allowedRoots: [root] }),
    (error: any) => error?.code === 'PATH_OUTSIDE_SCOPE'
  );
});
