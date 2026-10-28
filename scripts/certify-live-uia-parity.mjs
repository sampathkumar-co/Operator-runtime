// Explicit, opt-in PHYSICAL Windows UIA acceptance. Never use production account state.
// Run on a visible Windows desktop with a verified native UIA helper:
// MECORD_PHYSICAL_ACCEPTANCE=1 MECORD_TEST_UIA_HELPER=<absolute helper path>
// node --experimental-strip-types scripts/certify-live-uia-parity.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { WindowsUiaProvider } from '../src/capabilities/windows-uia.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { TaskStore } from '../src/core/task-store.ts';
import { TaskOrchestrator } from '../src/core/task-orchestrator.ts';
import { ApprovalStore } from '../apps/local-agent/src/approval-store.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

if (process.platform !== 'win32' || process.env.MECORD_PHYSICAL_ACCEPTANCE !== '1') {
  throw new Error('Physical UIA certification requires explicit Windows-only opt-in.');
}
const helper = process.env.MECORD_TEST_UIA_HELPER || '';
if (!path.win32.isAbsolute(helper) || !(await fs.stat(helper).catch(() => null))?.isFile()) {
  throw new Error('A separately verified absolute native Windows UIA helper path is required.');
}
const chromePath = process.env.MECORD_TEST_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!path.win32.isAbsolute(chromePath) || !(await fs.stat(chromePath).catch(() => null))?.isFile()) {
  throw new Error('Physical Chrome executable is missing; certification refused.');
}
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-physical-uia-parity-'));
const state = path.join(root, 'state');
const profile = path.join(root, 'chrome');
await fs.mkdir(state);
const server = http.createServer((req, res) => {
  const name = req.url === '/a' ? 'Mecord Isolated Tab Alpha' : 'Mecord Isolated Tab Beta';
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  res.end('<title>' + name + '</title><h1>' + name + '</h1>');
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const pageBase = 'http://127.0.0.1:' + server.address().port;
const chrome = spawn(chromePath, [
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-extensions', '--user-data-dir=' + profile,
  '--new-window', pageBase + '/a', pageBase + '/b'
], { windowsHide: false, stdio: 'ignore' });
let provider, runtime, agent;
try {
  await new Promise(r => setTimeout(r, 2000));
  assert(chrome.pid > 0 && chrome.exitCode === null, 'isolated Chrome must be running');
  provider = new WindowsUiaProvider({ binaryPath: helper, timeoutMs: 10_000 });
  let dispatches = 0;
  const counted = {
    name: provider.name,
    supports: action => provider.supports(action),
    score: () => provider.score(),
    async execute(action, context) {
      if (action.capability === 'app.operate') dispatches++;
      return await provider.execute(action, context);
    },
    close: () => provider.close()
  };
  runtime = new OperatorRuntime().register(counted);
  const permissions = {
    allowedCapabilities: ['app.inspect', 'app.operate'], allowedRoots: [],
    allowExternalWrites: false, allowDestructive: false, allowSystemChanges: false
  };
  const approvals = new ApprovalStore(state);
  const tasks = new TaskStore(state);
  const taskOrchestrator = new TaskOrchestrator({ runtime, store: tasks, permissions });
  const token = crypto.randomBytes(32).toString('hex');
  agent = createLocalAgentServer({
    runtime, token, permissions, approvals, tasks, taskOrchestrator, inlineApprovalWaitMs: 10
  });
  const { port } = await agent.listen('127.0.0.1', 0);
  const api = 'http://127.0.0.1:' + port;
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const selector = {
    name: 'Mecord Isolated Tab Beta', automationId: 'view_20',
    controlType: 'TabItem', processId: chrome.pid
  };
  const direct = await fetch(api + '/v1/execute', { method: 'POST', headers,
    body: JSON.stringify({ action: {
      id: crypto.randomUUID(), capability: 'app.operate', risk: 'external',
      input: { operation: 'select', selector }, provenance: { kind: 'chatgpt' }
    } })
  });
  const directBody = await direct.json();
  assert.equal(direct.status, 409);
  assert.equal(directBody.error?.code, 'APPROVAL_REQUIRED');
  assert.equal(dispatches, 0, 'direct denial must not dispatch native UIA');

  const submitted = await fetch(api + '/v1/tasks', { method: 'POST', headers,
    body: JSON.stringify({
      objective: 'Select isolated Chrome tab Beta', run: true,
      successConditions: ['Native Windows UIA verifies the exact selected tab'],
      goal: { kind: 'app-operation', operation: 'select', selector }
    })
  });
  const task = await submitted.json();
  assert.equal(submitted.status, 200, JSON.stringify(task).slice(0, 400));
  assert.equal(task.task?.state, 'BLOCKED', JSON.stringify(task).slice(0, 400));
  assert.equal(dispatches, 0, 'fresh durable denial must not dispatch UIA');

  const blocked = task.task.execution.records.find(record => record.state === 'BLOCKED');
  assert(blocked?.actionId);
  const pending = (await approvals.list()).find(item => item.actionId === blocked.actionId);
  assert(pending?.approvalRequestId);
  await approvals.approve(blocked.actionId, pending.approvalRequestId);
  const resumed = await fetch(api + '/v1/tasks/' + task.task.id + '/resume', {
    method: 'POST', headers, body: '{}'
  });
  const result = await resumed.json();
  assert.equal(resumed.status, 200, JSON.stringify(result).slice(0, 400));
  assert.equal(result.task.state, 'VERIFIED', JSON.stringify(result).slice(0, 400));
  assert.equal(dispatches, 1, 'only the exact authorized native action may execute');

  const repeated = await fetch(api + '/v1/tasks/' + task.task.id + '/resume', {
    method: 'POST', headers, body: '{}'
  });
  const repeatTask = await repeated.json();
  assert.equal(repeated.status, 409, JSON.stringify(repeatTask).slice(0, 400));
  assert.equal(repeatTask.error?.code, 'TASK_NOT_RESUMABLE');
  assert.equal(dispatches, 1, 'completed approved work must not redispatch on duplicate resume');

  const observed = await provider.execute({
    id: crypto.randomUUID(), capability: 'app.inspect', risk: 'read',
    provenance: { kind: 'runtime', source: 'physical-synthetic-parity' },
    input: {
      selector: {
        name: 'Mecord Isolated Tab Beta - Google Chrome', controlType: 'Window', processId: chrome.pid
      }, maxNodes: 120, maxDepth: 8
    }
  });
  assert.equal(observed.ok, true);
  const tabs = (observed.output?.elements ?? [])
    .filter(item => item.control_type === 'TabItem' && item.process_id === chrome.pid);
  assert(tabs.some(item => item.name === 'Mecord Isolated Tab Beta' && item.selected === true),
    'native UIA must independently verify Beta selected');
  assert(tabs.some(item => String(item.name).includes('Mecord Isolated Tab Alpha') && item.selected === false),
    'native UIA must independently verify Alpha unselected');

  console.log('P0_LIVE_UIA_PARITY_PASS=' + JSON.stringify({
    sourceCommit, platform: process.platform, node: process.version, native: true,
    direct: 'APPROVAL_REQUIRED', freshDurable: 'BLOCKED', postApproval: 'VERIFIED',
    dispatches, isolatedChrome: true
  }));
} finally {
  if (agent) await agent.close();
  if (runtime) await runtime.close();
  if (provider) await provider.close();
  try {
    if (chrome.pid) execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], {
      windowsHide: true, stdio: 'ignore', timeout: 7000
    });
  } catch { /* isolated Chrome may already have stopped */ }
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => setTimeout(resolve, 250));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
