import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PostgresProvider } from '../src/capabilities/postgres.ts';

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return await fs.realpath(dir);
}

async function makeSymlinkOrSkip(t: test.TestContext, target: string, link: string): Promise<boolean> {
  try {
    await fs.symlink(target, link, 'file');
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      t.skip(`symlink creation is unavailable on this runner (${code})`);
      return false;
    }
    throw error;
  }
}

function registry(projectRoot: string): string {
  return JSON.stringify({
    version: 1,
    profiles: [{
      id: 'local-safe',
      roots: [projectRoot],
      host: '127.0.0.1',
      port: 5432,
      database: 'operator_test',
      user: 'operator_user',
      sslMode: 'disable'
    }]
  });
}

function inspect(provider: PostgresProvider, projectRoot: string) {
  return provider.execute({
    id: 'postgres-boundary-inspect',
    capability: 'postgres.inspect',
    risk: 'read',
    input: { path: projectRoot, operation: 'profiles' },
    provenance: { kind: 'chatgpt' }
  });
}

test('PostgreSQL trusted registry refuses a symlinked authority file', async (t) => {
  const projectRoot = await tempDir(t, 'operator-pg-link-project-');
  const authorityRoot = await tempDir(t, 'operator-pg-link-authority-');
  const outsideRoot = await tempDir(t, 'operator-pg-link-outside-');
  const target = path.join(outsideRoot, 'profiles.json');
  const body = registry(projectRoot);
  await fs.writeFile(target, body, { mode: 0o600 });
  const registryPath = path.join(authorityRoot, 'postgres-profiles.json');
  if (!(await makeSymlinkOrSkip(t, target, registryPath))) return;

  const result = await inspect(new PostgresProvider({ allowedRoots: [projectRoot], registryPath }), projectRoot);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'POSTGRES_REGISTRY_INVALID');
  assert.equal(await fs.readFile(target, 'utf8'), body);
  assert.equal((await fs.lstat(registryPath)).isSymbolicLink(), true);
});

test('PostgreSQL trusted registry refuses hard-linked authority files', async (t) => {
  const projectRoot = await tempDir(t, 'operator-pg-hardlink-project-');
  const authorityRoot = await tempDir(t, 'operator-pg-hardlink-authority-');
  const outsideRoot = await tempDir(t, 'operator-pg-hardlink-outside-');
  const target = path.join(outsideRoot, 'profiles.json');
  const body = registry(projectRoot);
  await fs.writeFile(target, body, { mode: 0o600 });
  const registryPath = path.join(authorityRoot, 'postgres-profiles.json');
  try {
    await fs.link(target, registryPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'EXDEV') {
      t.skip(`hard-link creation is unavailable on this runner (${code})`);
      return;
    }
    throw error;
  }

  const result = await inspect(new PostgresProvider({ allowedRoots: [projectRoot], registryPath }), projectRoot);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'POSTGRES_REGISTRY_INVALID');
  assert.ok((await fs.lstat(registryPath)).nlink > 1);
  assert.equal(await fs.readFile(target, 'utf8'), body);
});

test('PostgreSQL trusted registry remains bounded before JSON parsing', async (t) => {
  const projectRoot = await tempDir(t, 'operator-pg-large-project-');
  const authorityRoot = await tempDir(t, 'operator-pg-large-authority-');
  const registryPath = path.join(authorityRoot, 'postgres-profiles.json');
  await fs.writeFile(registryPath, 'x'.repeat(256 * 1024 + 1), { mode: 0o600 });

  const result = await inspect(new PostgresProvider({ allowedRoots: [projectRoot], registryPath }), projectRoot);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'POSTGRES_REGISTRY_INVALID');
});

test('PostgreSQL registry symlink into an authorized project is denied as project-owned authority', async (t) => {
  const projectRoot = await tempDir(t, 'operator-pg-project-owned-');
  const authorityRoot = await tempDir(t, 'operator-pg-project-owned-authority-');
  const projectFile = path.join(projectRoot, 'attacker-profiles.json');
  await fs.writeFile(projectFile, registry(projectRoot), { mode: 0o600 });
  const registryPath = path.join(authorityRoot, 'postgres-profiles.json');
  if (!(await makeSymlinkOrSkip(t, projectFile, registryPath))) return;

  const result = await inspect(new PostgresProvider({ allowedRoots: [projectRoot], registryPath }), projectRoot);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'POSTGRES_REGISTRY_INSIDE_PROJECT_DENIED');
});
