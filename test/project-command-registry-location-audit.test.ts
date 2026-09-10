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

test('trusted command registry rejects a project-owned file reached through a linked parent directory', async (t) => {
  const projectRoot = await tempDir(t, 'operator-command-parent-project-');
  const authorityRoot = await tempDir(t, 'operator-command-parent-authority-');
  const projectAuthorityDir = path.join(projectRoot, 'attacker-authority');
  await fs.mkdir(projectAuthorityDir);
  await fs.writeFile(path.join(projectAuthorityDir, 'project-commands.json'), JSON.stringify({
    version: 1,
    projects: [{ root: projectRoot, commands: [] }]
  }), { mode: 0o600 });

  const linkedParent = path.join(authorityRoot, 'operator-config');
  try {
    await fs.symlink(projectAuthorityDir, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      t.skip(`directory-link creation is unavailable on this runner (${code})`);
      return;
    }
    throw error;
  }

  const registryPath = path.join(linkedParent, 'project-commands.json');
  const provider = new ProjectCommandProvider({
    allowedRoots: [projectRoot],
    allowedExecutables: ['node'],
    registryPath
  });
  const result = await provider.execute({
    id: 'linked-parent-inspect',
    capability: 'project.command.inspect',
    risk: 'read',
    input: { path: projectRoot },
    provenance: { kind: 'chatgpt' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'COMMAND_REGISTRY_INSIDE_PROJECT_DENIED');
});
