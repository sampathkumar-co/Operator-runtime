import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectCommandProvider } from '../src/capabilities/project-command.ts';

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

function inspect(provider: ProjectCommandProvider, projectRoot: string) {
  return provider.execute({
    id: 'inspect-registry-boundary',
    capability: 'project.command.inspect',
    risk: 'read',
    input: { path: projectRoot },
    provenance: { kind: 'chatgpt' }
  });
}

test('project command inspect does not disclose the absolute trusted registry path', async (t) => {
  const projectRoot = await tempDir(t, 'operator-registry-privacy-project-');
  const authorityRoot = await tempDir(t, 'operator-registry-privacy-authority-');
  const registryPath = path.join(authorityRoot, 'project-commands.json');
  await fs.writeFile(registryPath, JSON.stringify({
    version: 1,
    projects: [{ root: projectRoot, commands: [] }]
  }), { mode: 0o600 });

  const provider = new ProjectCommandProvider({ allowedRoots: [projectRoot], allowedExecutables: ['node'], registryPath });
  const result = await inspect(provider, projectRoot);
  assert.equal(result.ok, true, result.error?.message);
  const output = result.output as Record<string, unknown>;
  assert.equal(output.registryConfigured, true);
  assert.equal(output.registryLocation, 'operator-local-config');
  assert.equal('registryPath' in output, false);
  assert.equal(JSON.stringify(output).includes(registryPath), false);
});

test('unrelated out-of-scope registry projects cannot poison matching of an authorized project', async (t) => {
  const projectRoot = await tempDir(t, 'operator-registry-match-project-');
  const unrelatedRoot = await tempDir(t, 'operator-registry-match-unrelated-');
  const authorityRoot = await tempDir(t, 'operator-registry-match-authority-');
  const registryPath = path.join(authorityRoot, 'project-commands.json');
  await fs.writeFile(registryPath, JSON.stringify({
    version: 1,
    projects: [
      { root: unrelatedRoot, commands: [] },
      { root: path.join(unrelatedRoot, 'does-not-exist'), commands: [] },
      {
        root: projectRoot,
        commands: [{ id: 'safe-test', executable: 'node', args: ['--version'], cwd: '.', risk: 'read' }]
      }
    ]
  }), { mode: 0o600 });

  const provider = new ProjectCommandProvider({ allowedRoots: [projectRoot], allowedExecutables: ['node'], registryPath });
  const result = await inspect(provider, projectRoot);
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual((result.output as any).commands.map((command: any) => command.id), ['safe-test']);
});

test('trusted project command registry refuses a symlinked authority file', async (t) => {
  const projectRoot = await tempDir(t, 'operator-registry-symlink-project-');
  const authorityRoot = await tempDir(t, 'operator-registry-symlink-authority-');
  const outsideRoot = await tempDir(t, 'operator-registry-symlink-outside-');
  const outside = path.join(outsideRoot, 'outside-registry.json');
  const registryPath = path.join(authorityRoot, 'project-commands.json');
  const sentinel = JSON.stringify({ version: 1, projects: [{ root: projectRoot, commands: [] }] });
  await fs.writeFile(outside, sentinel, { mode: 0o600 });
  if (!(await makeSymlinkOrSkip(t, outside, registryPath))) return;

  const provider = new ProjectCommandProvider({ allowedRoots: [projectRoot], allowedExecutables: ['node'], registryPath });
  const result = await inspect(provider, projectRoot);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'COMMAND_REGISTRY_INVALID');
  assert.equal(await fs.readFile(outside, 'utf8'), sentinel);
  assert.equal((await fs.lstat(registryPath)).isSymbolicLink(), true);
});

test('trusted project command registry refuses hard-linked authority files', async (t) => {
  const projectRoot = await tempDir(t, 'operator-registry-hardlink-project-');
  const authorityRoot = await tempDir(t, 'operator-registry-hardlink-authority-');
  const outsideRoot = await tempDir(t, 'operator-registry-hardlink-outside-');
  const outside = path.join(outsideRoot, 'outside-registry.json');
  const registryPath = path.join(authorityRoot, 'project-commands.json');
  const sentinel = JSON.stringify({ version: 1, projects: [{ root: projectRoot, commands: [] }] });
  await fs.writeFile(outside, sentinel, { mode: 0o600 });
  try {
    await fs.link(outside, registryPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'EXDEV') {
      t.skip(`hard-link creation is unavailable on this runner (${code})`);
      return;
    }
    throw error;
  }

  const provider = new ProjectCommandProvider({ allowedRoots: [projectRoot], allowedExecutables: ['node'], registryPath });
  const result = await inspect(provider, projectRoot);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'COMMAND_REGISTRY_INVALID');
  assert.equal(await fs.readFile(outside, 'utf8'), sentinel);
  assert.ok((await fs.lstat(registryPath)).nlink > 1);
});
