import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectCommandProvider } from '../src/capabilities/project-command.ts';

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('project command execution ignores repository-authored scripts and uses only the external trusted registry', async (t) => {
  const projectRoot = await tempDir(t, 'operator-project-command-project-');
  const authorityRoot = await tempDir(t, 'operator-project-command-authority-');
  const registryPath = path.join(authorityRoot, 'project-commands.json');
  const repoMarker = path.join(projectRoot, 'repo-script-ran.marker');

  await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'untrusted-project',
    scripts: {
      test: `node -e "require('fs').writeFileSync(${JSON.stringify(repoMarker)}, 'bad')"`
    }
  }, null, 2));
  await fs.mkdir(path.join(projectRoot, '.operator'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, '.operator', 'project-commands.json'), JSON.stringify({
    version: 1,
    projects: [{
      root: projectRoot,
      commands: [{ id: 'repo-owned', executable: 'node', args: ['-e', 'process.exit(99)'], cwd: '.', risk: 'read' }]
    }]
  }));

  await fs.writeFile(registryPath, JSON.stringify({
    version: 1,
    projects: [{
      root: projectRoot,
      commands: [{
        id: 'trusted-test',
        title: 'Trusted test command',
        kind: 'test',
        executable: 'node',
        args: ['-e', "process.stdout.write('trusted-ok')"],
        cwd: '.',
        timeoutMs: 5000,
        risk: 'read'
      }]
    }]
  }, null, 2));

  const provider = new ProjectCommandProvider({
    allowedRoots: [projectRoot],
    allowedExecutables: ['node'],
    registryPath
  });

  const inspected = await provider.execute({
    id: 'inspect-trusted-commands',
    capability: 'project.command.inspect',
    risk: 'read',
    input: { path: projectRoot },
    provenance: { kind: 'chatgpt' }
  });
  assert.equal(inspected.ok, true, inspected.error?.message);
  const inspectOutput = inspected.output as any;
  assert.equal(inspectOutput.registryConfigured, true);
  assert.deepEqual(inspectOutput.commands.map((command: any) => command.id), ['trusted-test']);
  assert.equal(inspectOutput.commands.some((command: any) => command.id === 'repo-owned'), false);

  const executed = await provider.execute({
    id: 'run-trusted-command',
    capability: 'project.command.run',
    risk: 'read',
    input: { path: projectRoot, commandId: 'trusted-test', expectedRisk: 'read' },
    provenance: { kind: 'chatgpt' }
  });
  assert.equal(executed.ok, true, executed.error?.message);
  assert.equal((executed.output as any).command.id, 'trusted-test');
  assert.equal((executed.output as any).execution.stdout, 'trusted-ok');
  assert.equal((executed.output as any).execution.exitCode, 0);
  await assert.rejects(fs.access(repoMarker));
});

test('project command provider rejects policy-risk mismatch before execution', async (t) => {
  const projectRoot = await tempDir(t, 'operator-project-command-risk-project-');
  const authorityRoot = await tempDir(t, 'operator-project-command-risk-authority-');
  const registryPath = path.join(authorityRoot, 'project-commands.json');
  const marker = path.join(projectRoot, 'should-not-run.marker');

  await fs.writeFile(registryPath, JSON.stringify({
    version: 1,
    projects: [{
      root: projectRoot,
      commands: [{
        id: 'external-command',
        executable: 'node',
        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
        cwd: '.',
        risk: 'external'
      }]
    }]
  }));

  const provider = new ProjectCommandProvider({
    allowedRoots: [projectRoot],
    allowedExecutables: ['node'],
    registryPath
  });

  const rejected = await provider.execute({
    id: 'risk-bypass-attempt',
    capability: 'project.command.run',
    risk: 'read',
    input: { path: projectRoot, commandId: 'external-command', expectedRisk: 'external' },
    provenance: { kind: 'chatgpt' }
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error?.code, 'PROJECT_COMMAND_ACTION_RISK_MISMATCH');
  await assert.rejects(fs.access(marker));
});

test('trusted project command registry is rejected when stored inside an authorized project root', async (t) => {
  const projectRoot = await tempDir(t, 'operator-project-command-inside-project-');
  const registryPath = path.join(projectRoot, 'project-commands.json');
  await fs.writeFile(registryPath, JSON.stringify({ version: 1, projects: [] }));

  const provider = new ProjectCommandProvider({
    allowedRoots: [projectRoot],
    allowedExecutables: ['node'],
    registryPath
  });

  const rejected = await provider.execute({
    id: 'inside-project-registry',
    capability: 'project.command.inspect',
    risk: 'read',
    input: { path: projectRoot },
    provenance: { kind: 'chatgpt' }
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error?.code, 'COMMAND_REGISTRY_INSIDE_PROJECT_DENIED');
});
