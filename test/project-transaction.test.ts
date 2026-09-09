import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectTransactionProvider } from '../src/capabilities/project-transaction.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function setup(t: test.TestContext, commands: unknown[]): Promise<{ projectRoot: string; registryPath: string }> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-transaction-project-'));
  const authorityRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-transaction-authority-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  t.after(() => fs.rm(authorityRoot, { recursive: true, force: true }));

  git(projectRoot, 'init', '-b', 'main');
  git(projectRoot, 'config', 'user.name', 'Operator CI');
  git(projectRoot, 'config', 'user.email', 'operator-ci@example.invalid');
  await fs.writeFile(path.join(projectRoot, 'app.txt'), 'base\n');
  git(projectRoot, 'add', 'app.txt');
  git(projectRoot, 'commit', '-m', 'base');

  const registryPath = path.join(authorityRoot, 'project-commands.json');
  await fs.writeFile(registryPath, JSON.stringify({
    version: 1,
    projects: [{ root: projectRoot, commands }]
  }, null, 2));
  return { projectRoot, registryPath };
}

test('project transaction keeps verified mutation and retains a manual recovery checkpoint', async (t) => {
  const { projectRoot, registryPath } = await setup(t, [{
    id: 'verified-local-write',
    kind: 'build',
    executable: 'node',
    args: ['-e', "require('fs').writeFileSync('app.txt','verified\\n')"],
    cwd: '.',
    risk: 'write',
    artifacts: [{ path: 'app.txt', kind: 'file', minBytes: 2, mustChange: true }]
  }]);
  const provider = new ProjectTransactionProvider({ allowedRoots: [projectRoot], allowedExecutables: ['node'], registryPath });

  const result = await provider.execute({
    id: 'transaction-success',
    capability: 'project.transaction.run',
    risk: 'destructive',
    input: { path: projectRoot, commandId: 'verified-local-write', expectedRisk: 'write' },
    provenance: { kind: 'chatgpt' }
  });

  assert.equal(result.ok, true, result.error?.message);
  assert.equal((result.output as any).rollbackPerformed, false);
  assert.match(String((result.output as any).checkpointId), /^[0-9a-f-]{36}$/i);
  assert.equal(await fs.readFile(path.join(projectRoot, 'app.txt'), 'utf8'), 'verified\n');
  assert.match(git(projectRoot, 'status', '--porcelain=v1'), /^ M app\.txt\n$/);
});

test('project transaction restores exact Git state when command exits zero but artifact verification fails', async (t) => {
  const script = [
    "const fs=require('fs')",
    "fs.writeFileSync('app.txt','broken-but-zero-exit\\n')",
    "process.stdout.write('zero')"
  ].join(';');
  const { projectRoot, registryPath } = await setup(t, [{
    id: 'false-green-local-write',
    kind: 'build',
    executable: 'node',
    args: ['-e', script],
    cwd: '.',
    risk: 'write',
    artifacts: [{ path: 'required-report.json', kind: 'json', minBytes: 2, mustChange: true }]
  }]);
  const provider = new ProjectTransactionProvider({ allowedRoots: [projectRoot], allowedExecutables: ['node'], registryPath });

  const result = await provider.execute({
    id: 'transaction-rollback',
    capability: 'project.transaction.run',
    risk: 'destructive',
    input: { path: projectRoot, commandId: 'false-green-local-write', expectedRisk: 'write' },
    provenance: { kind: 'chatgpt' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'TRANSACTION_FAILED_ROLLED_BACK');
  assert.equal((result.output as any).rollbackPerformed, true);
  assert.equal((result.output as any).command.error.code, 'ARTIFACT_VALIDATION_FAILED');
  assert.equal(await fs.readFile(path.join(projectRoot, 'app.txt'), 'utf8'), 'base\n');
  assert.equal(git(projectRoot, 'status', '--porcelain=v1'), '');
});

test('project transaction rejects non-destructive authorization before command execution', async (t) => {
  const marker = 'should-not-run.marker';
  const { projectRoot, registryPath } = await setup(t, [{
    id: 'local-write',
    executable: 'node',
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`],
    cwd: '.',
    risk: 'write'
  }]);
  const provider = new ProjectTransactionProvider({ allowedRoots: [projectRoot], allowedExecutables: ['node'], registryPath });

  const result = await provider.execute({
    id: 'transaction-risk-bypass',
    capability: 'project.transaction.run',
    risk: 'write',
    input: { path: projectRoot, commandId: 'local-write', expectedRisk: 'write' },
    provenance: { kind: 'chatgpt' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'TRANSACTION_DESTRUCTIVE_RISK_REQUIRED');
  await assert.rejects(fs.access(path.join(projectRoot, marker)));
});

test('project transaction refuses external trusted commands because their effects are not Git-reversible', async (t) => {
  const marker = 'external-should-not-run.marker';
  const { projectRoot, registryPath } = await setup(t, [{
    id: 'external-command',
    executable: 'node',
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`],
    cwd: '.',
    risk: 'external'
  }]);
  const provider = new ProjectTransactionProvider({ allowedRoots: [projectRoot], allowedExecutables: ['node'], registryPath });

  const result = await provider.execute({
    id: 'transaction-external',
    capability: 'project.transaction.run',
    risk: 'destructive',
    input: { path: projectRoot, commandId: 'external-command', expectedRisk: 'external' },
    provenance: { kind: 'chatgpt' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'TRANSACTION_RISK_UNSUPPORTED');
  await assert.rejects(fs.access(path.join(projectRoot, marker)));
});
