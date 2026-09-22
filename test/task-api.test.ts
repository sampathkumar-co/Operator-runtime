import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';
import { TaskOrchestrator } from '../src/core/task-orchestrator.ts';
import { TaskStore } from '../src/core/task-store.ts';
import { supportedGitAvailable } from './git-test-support.ts';

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('authenticated task API submits, executes, and reads a durable multi-action goal', async (t) => {
  if (!supportedGitAvailable()) { t.skip('supported Git executable is unavailable'); return; }
  const root = await tempDir(t, 'operator-task-api-root-');
  const outside = await tempDir(t, 'operator-task-api-outside-');
  const state = await tempDir(t, 'operator-task-api-state-');
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => execFile('git', ['init', '--quiet'], { cwd: root }, (error) => error ? reject(error) : resolve()));
  const runtime = createRuntime({
    allowedRoots: [root], allowedExecutables: ['node'], terminalAllowedExecutables: [],
    windowsPathLeasePath: process.platform === 'win32'
      ? path.resolve('native/windows-path-lease/target/release/operator-windows-path-lease.exe')
      : undefined
  });
  const tasks = new TaskStore(state);
  const permissions = {
    allowedCapabilities: ['file.list', 'file.create', 'file.read', 'git.status'],
    allowedRoots: [root], allowDestructive: false, allowExternalWrites: false, allowSystemChanges: false
  };
  const taskOrchestrator = new TaskOrchestrator({ runtime, store: tasks, permissions });
  const token = 't'.repeat(64);
  const agent = createLocalAgentServer({ runtime, token, permissions, tasks, taskOrchestrator });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const bound = await agent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${bound.port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const denied = await fetch(`${base}/v1/tasks`, {
    method: 'POST', headers,
    body: JSON.stringify({
      objective: 'escape', successConditions: ['bad'],
      goal: { kind: 'controlled-file-change', root: outside, path: 'escape.txt', content: 'bad' }
    })
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json() as any).error.code, 'TASK_SCOPE_DENIED');

  const response = await fetch(`${base}/v1/tasks`, {
    method: 'POST', headers,
    body: JSON.stringify({
      objective: 'Create and verify an API-submitted file.',
      successConditions: ['exact content', 'visible to Git'], run: true,
      goal: { kind: 'controlled-file-change', root, path: 'api-output.txt', content: 'from task api\n' }
    })
  });
  assert.equal(response.status, 200);
  const submitted = await response.json() as any;
  assert.equal(submitted.ok, true);
  assert.equal(submitted.task.state, 'VERIFIED');
  assert.equal(submitted.task.execution.records.length, 4);
  assert.equal(await fs.readFile(path.join(root, 'api-output.txt'), 'utf8'), 'from task api\n');

  const fetched = await fetch(`${base}/v1/tasks/${submitted.task.id}`, { headers });
  assert.equal(fetched.status, 200);
  const persisted = await fetched.json() as any;
  assert.equal(persisted.task.id, submitted.task.id);
  assert.equal(persisted.task.state, 'VERIFIED');
});

test('task API requires separate recovery authority for the exact blocked action', async (t) => {
  const root = await tempDir(t, 'operator-task-api-approval-root-');
  const authority = await tempDir(t, 'operator-task-api-approval-authority-');
  const state = await tempDir(t, 'operator-task-api-approval-state-');
  const marker = path.join(root, 'external.marker');
  const registryPath = path.join(authority, 'commands.json');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'approval-fixture' }));
  await fs.writeFile(registryPath, JSON.stringify({
    version: 1,
    projects: [{ root, commands: [{
      id: 'approved-build', kind: 'build', executable: 'node',
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'approved')`],
      cwd: '.', risk: 'external', artifacts: [{ path: 'external.marker', kind: 'file', minBytes: 1, mustChange: true }]
    }] }]
  }));
  const runtime = createRuntime({
    allowedRoots: [root], allowedExecutables: ['node'], terminalAllowedExecutables: [],
    projectCommandRegistryPath: registryPath
  });
  const tasks = new TaskStore(state);
  const permissions = {
    allowedCapabilities: ['project.inspect', 'project.command.inspect', 'project.command.run'],
    allowedRoots: [root], allowDestructive: false, allowExternalWrites: false, allowSystemChanges: false
  };
  const taskOrchestrator = new TaskOrchestrator({ runtime, store: tasks, permissions });
  const token = 'a'.repeat(64);
  const recoveryToken = 'r'.repeat(64);
  const agent = createLocalAgentServer({ runtime, token, recoveryToken, permissions, tasks, taskOrchestrator });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const bound = await agent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${bound.port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const blockedResponse = await fetch(`${base}/v1/tasks`, {
    method: 'POST', headers,
    body: JSON.stringify({
      objective: 'Run an explicitly approved build.', successConditions: ['validated artifact'], run: true,
      goal: { kind: 'trusted-project-command', root, commandKind: 'build' }
    })
  });
  const blocked = await blockedResponse.json() as any;
  assert.equal(blocked.task.state, 'BLOCKED');
  const actionId = blocked.task.execution.records.at(-1).actionId as string;
  await assert.rejects(fs.access(marker));

  const unauthorized = await fetch(`${base}/v1/tasks/${blocked.task.id}/resume`, {
    method: 'POST', headers, body: JSON.stringify({ approvedActionId: actionId })
  });
  assert.equal(unauthorized.status, 401);
  await assert.rejects(fs.access(marker));

  const approved = await fetch(`${base}/v1/tasks/${blocked.task.id}/resume`, {
    method: 'POST',
    headers: { ...headers, 'x-operator-recovery-token': recoveryToken },
    body: JSON.stringify({ approvedActionId: actionId })
  });
  assert.equal(approved.status, 200);
  const completed = await approved.json() as any;
  assert.equal(completed.task.state, 'VERIFIED');
  assert.equal(await fs.readFile(marker, 'utf8'), 'approved');
});
