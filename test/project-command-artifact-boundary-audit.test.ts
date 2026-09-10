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

async function run(provider: ProjectCommandProvider, projectRoot: string, commandId: string) {
  return await provider.execute({
    id: `artifact-boundary-${commandId}`,
    capability: 'project.command.run',
    risk: 'write',
    input: { path: projectRoot, commandId, expectedRisk: 'write' },
    provenance: { kind: 'chatgpt' }
  });
}

async function writeRegistry(file: string, projectRoot: string, command: Record<string, unknown>): Promise<void> {
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    projects: [{ root: projectRoot, commands: [command] }]
  }, null, 2), { mode: 0o600 });
}

test('trusted artifact preflight rejects a missing output reached through a linked parent before execution', async (t) => {
  const projectRoot = await tempDir(t, 'operator-artifact-parent-project-');
  const authorityRoot = await tempDir(t, 'operator-artifact-parent-authority-');
  const outsideRoot = await tempDir(t, 'operator-artifact-parent-outside-');
  const registryPath = path.join(authorityRoot, 'project-commands.json');
  const marker = path.join(projectRoot, 'command-ran.marker');
  const linked = path.join(projectRoot, 'linked');
  try {
    await fs.symlink(outsideRoot, linked, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      t.skip(`directory link creation is unavailable on this runner (${code})`);
      return;
    }
    throw error;
  }
  await writeRegistry(registryPath, projectRoot, {
    id: 'linked-parent', executable: 'node', risk: 'write', cwd: '.',
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
    artifacts: [{ path: 'linked/result.json', kind: 'json', minBytes: 2 }]
  });

  const provider = new ProjectCommandProvider({ allowedRoots: [projectRoot], allowedExecutables: ['node'], registryPath });
  const result = await run(provider, projectRoot, 'linked-parent');
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'ARTIFACT_PATH_OUTSIDE_PROJECT');
  await assert.rejects(fs.access(marker));
});

test('trusted artifact preflight rejects hard-linked files before execution', async (t) => {
  const projectRoot = await tempDir(t, 'operator-artifact-hardlink-project-');
  const authorityRoot = await tempDir(t, 'operator-artifact-hardlink-authority-');
  const outsideRoot = await tempDir(t, 'operator-artifact-hardlink-outside-');
  const registryPath = path.join(authorityRoot, 'project-commands.json');
  const marker = path.join(projectRoot, 'command-ran.marker');
  const outside = path.join(outsideRoot, 'result.json');
  const dist = path.join(projectRoot, 'dist');
  const artifactPath = path.join(dist, 'result.json');
  await fs.mkdir(dist, { recursive: true });
  await fs.writeFile(outside, '{"ok":true}', { mode: 0o600 });
  try {
    await fs.link(outside, artifactPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'EXDEV') {
      t.skip(`hard-link creation is unavailable on this runner (${code})`);
      return;
    }
    throw error;
  }
  await writeRegistry(registryPath, projectRoot, {
    id: 'hardlinked-artifact', executable: 'node', risk: 'write', cwd: '.',
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
    artifacts: [{ path: 'dist/result.json', kind: 'json', minBytes: 2 }]
  });

  const provider = new ProjectCommandProvider({ allowedRoots: [projectRoot], allowedExecutables: ['node'], registryPath });
  const result = await run(provider, projectRoot, 'hardlinked-artifact');
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'ARTIFACT_FILE_INVALID');
  await assert.rejects(fs.access(marker));
  assert.ok((await fs.lstat(artifactPath)).nlink > 1);
});
