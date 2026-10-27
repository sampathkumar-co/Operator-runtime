import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { ProcessProvider, processInstanceFingerprint } from '../src/capabilities/process.ts';
import type { ActionRisk } from '../src/core/types.ts';

// CI runners execute many filesystem/process suites concurrently; allow bounded
// scheduler/antivirus startup slack for ordinary completion tests. Explicit
// timeout/kill tests keep their own short limits and remain fail-closed.
const TEST_PROCESS_TIMEOUT_MS = process.env.CI === 'true' ? 20_000 : 5_000;
function request(executable: string, args: string[], cwd: string, risk: ActionRisk = 'write') {
  return {
    id: crypto.randomUUID(), capability: 'terminal.execute', risk,
    input: { executable, args, cwd, timeoutMs: TEST_PROCESS_TIMEOUT_MS }, provenance: { kind: 'chatgpt' as const }
  };
}

test('process instance fingerprint rejects same-PID reuse with a different creation time', () => {
  const first = processInstanceFingerprint('node.exe', 4242, 'Console', 1, '2026-01-01T00:00:00.000Z');
  const reused = processInstanceFingerprint('node.exe', 4242, 'Console', 1, '2026-01-01T00:01:00.000Z');
  assert.notEqual(first, reused);
});

test('process provider uses allowlisted argv execution', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-proc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['node'] });
  const result = await provider.execute(request('node', ['-e', 'process.stdout.write("ok")'], root));
  assert.equal(result.ok, true);
  assert.equal((result.output as { stdout: string }).stdout, 'ok');
});

test('non-allowlisted executable is denied', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-proc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['node'] });
  const result = await provider.execute(request('git', ['status'], root));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'EXECUTABLE_DENIED');
});

test('generic process provider can enforce destructive risk independently of caller input', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-proc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new ProcessProvider({
    allowedRoots: [root],
    allowedExecutables: ['node'],
    requiredRisk: 'destructive'
  });

  const underclassified = await provider.execute(request('node', ['-e', 'process.stdout.write("should-not-run")'], root, 'write'));
  assert.equal(underclassified.ok, false);
  assert.equal(underclassified.error?.code, 'PROCESS_RISK_MISMATCH');

  const approvedClass = await provider.execute(request('node', ['-e', 'process.stdout.write("ok")'], root, 'destructive'));
  assert.equal(approvedClass.ok, true);
  assert.equal((approvedClass.output as { stdout: string }).stdout, 'ok');
});

test('child process environment excludes ambient credentials and runtime injection variables', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-proc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const previous = {
    operator: process.env.OPERATOR_AGENT_TOKEN,
    aws: process.env.AWS_SECRET_ACCESS_KEY,
    nodeOptions: process.env.NODE_OPTIONS
  };
  process.env.OPERATOR_AGENT_TOKEN = 'operator-secret-that-must-not-cross-process-boundary';
  process.env.AWS_SECRET_ACCESS_KEY = 'ambient-cloud-secret-that-must-not-cross';
  process.env.NODE_OPTIONS = '--no-warnings';
  t.after(() => {
    if (previous.operator === undefined) delete process.env.OPERATOR_AGENT_TOKEN; else process.env.OPERATOR_AGENT_TOKEN = previous.operator;
    if (previous.aws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = previous.aws;
    if (previous.nodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous.nodeOptions;
  });

  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['node'] });
  const script = [
    'process.stdout.write(JSON.stringify({',
    'operator: process.env.OPERATOR_AGENT_TOKEN ?? null,',
    'aws: process.env.AWS_SECRET_ACCESS_KEY ?? null,',
    'nodeOptions: process.env.NODE_OPTIONS ?? null,',
    'hasPath: Boolean(process.env.PATH || process.env.Path)',
    '}))'
  ].join('');
  const result = await provider.execute(request('node', ['-e', script], root));
  assert.equal(result.ok, true);
  const payload = JSON.parse((result.output as { stdout: string }).stdout) as Record<string, unknown>;
  assert.equal(payload.operator, null);
  assert.equal(payload.aws, null);
  assert.equal(payload.nodeOptions, null);
  assert.equal(payload.hasPath, true);
});

test('trusted process environment overrides replace scrubbed ambient values', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-proc-env-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = 'ambient-should-not-cross';
  t.after(() => { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; });
  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['node'], environmentOverrides: { GIT_CONFIG_GLOBAL: 'trusted-null', GIT_CONFIG_NOSYSTEM: '1' } });
  const script = 'process.stdout.write(JSON.stringify({global:process.env.GIT_CONFIG_GLOBAL,nosystem:process.env.GIT_CONFIG_NOSYSTEM}))';
  const result = await provider.execute(request('node', ['-e', script], root));
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(JSON.parse((result.output as { stdout: string }).stdout), { global: 'trusted-null', nosystem: '1' });
});

test('process arguments reject NUL and excessive entries before spawn', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-proc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['node'] });

  const nul = await provider.execute(request('node', ['bad\0arg'], root));
  assert.equal(nul.ok, false);
  assert.equal(nul.error?.code, 'PROCESS_INPUT_INVALID');

  const tooMany = await provider.execute(request('node', Array.from({ length: 201 }, () => 'x'), root));
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.error?.code, 'PROCESS_INPUT_INVALID');
});

test('Windows terminal timeout quiesces a detached descendant before returning', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows process-tree containment regression');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-proc-tree-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'survived.txt');
  const descendant = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'survived'),1500)`;
  const parent = `const{spawn}=require('child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'});c.unref();setInterval(()=>{},1000)`;
  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['node'] });
  const result = await provider.execute({
    id: crypto.randomUUID(), capability: 'terminal.execute', risk: 'destructive',
    input: { executable: 'node', args: ['-e', parent], cwd: root, timeoutMs: 200 }, provenance: { kind: 'chatgpt' as const }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'PROCESS_TIMEOUT');
  assert.equal(result.error?.sideEffectState, 'uncertain');
  await new Promise((resolve) => setTimeout(resolve, 1800));
  await assert.rejects(fs.access(marker));
});

test('Windows executable lookup ignores an authorized cwd shadow binary', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows cwd-first executable lookup regression');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-proc-shadow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.copyFile(process.execPath, path.join(root, 'git.exe'));

  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['git'] });
  const result = await provider.execute(request('git', ['--version'], root, 'write'));
  assert.equal(result.ok, true, result.error?.message);
  assert.match((result.output as { stdout: string }).stdout, /^git version /i);
});


test('interactive terminal session supports start, stdin, cursor output, list and termination', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-session-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['node'] });
  t.after(() => provider.close());

  const start = await provider.execute({
    id: crypto.randomUUID(), capability: 'terminal.session', risk: 'destructive',
    input: {
      operation: 'start', executable: 'node', cwd: root,
      args: ['-e', 'process.stdin.setEncoding("utf8");process.stdin.on("data",d=>process.stdout.write("echo:"+d));setInterval(()=>{},1000)']
    },
    provenance: { kind: 'chatgpt' as const }
  });
  assert.equal(start.ok, true, start.error?.message);
  const sessionId = (start.output as any).sessionId as string;
  assert.match(sessionId, /^[0-9a-f-]{36}$/);

  const write = await provider.execute({
    id: crypto.randomUUID(), capability: 'terminal.session', risk: 'destructive',
    input: { operation: 'write', sessionId, input: 'hello\n' }, provenance: { kind: 'chatgpt' as const }
  });
  assert.equal(write.ok, true, write.error?.message);

  let read: Awaited<ReturnType<ProcessProvider['execute']>> | undefined;
  let events: Array<{ stream: string; text: string; cursor: number }> = [];
  let cursor = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    read = await provider.execute({
      id: crypto.randomUUID(), capability: 'terminal.session', risk: 'read',
      input: { operation: 'read', sessionId, afterCursor: cursor, maxEvents: 50 }, provenance: { kind: 'chatgpt' as const }
    });
    assert.equal(read.ok, true, read.error?.message);
    const batch = (read.output as any).events as Array<{ stream: string; text: string; cursor: number }>;
    events.push(...batch);
    cursor = (read.output as any).cursor as number;
    if (events.some((event) => event.stream === 'stdout' && event.text.includes('echo:hello'))) break;
  }
  assert.ok(events.some((event) => event.stream === 'stdout' && event.text.includes('echo:hello')));

  const emptyRead = await provider.execute({
    id: crypto.randomUUID(), capability: 'terminal.session', risk: 'read',
    input: { operation: 'read', sessionId, afterCursor: cursor, maxEvents: 50 }, provenance: { kind: 'chatgpt' as const }
  });
  assert.equal(emptyRead.ok, true);
  assert.equal((emptyRead.output as any).events.length, 0);

  const list = await provider.execute({
    id: crypto.randomUUID(), capability: 'terminal.session', risk: 'read',
    input: { operation: 'list' }, provenance: { kind: 'chatgpt' as const }
  });
  assert.equal(list.ok, true);
  assert.ok(((list.output as any).sessions as any[]).some((session) => session.sessionId === sessionId));

  const terminate = await provider.execute({
    id: crypto.randomUUID(), capability: 'terminal.session', risk: 'destructive',
    input: { operation: 'terminate', sessionId }, provenance: { kind: 'chatgpt' as const }
  });
  assert.equal(terminate.ok, true, terminate.error?.message);
});

test('terminal session refuses non-allowlisted executables before process creation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-session-deny-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['node'] });
  t.after(() => provider.close());
  const denied = await provider.execute({
    id: crypto.randomUUID(), capability: 'terminal.session', risk: 'destructive',
    input: { operation: 'start', executable: 'git', args: ['status'], cwd: root },
    provenance: { kind: 'chatgpt' as const }
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error?.code, 'EXECUTABLE_DENIED');
});

test('Windows process inspection returns bounded metadata without command lines', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only process inspection');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-process-inspect-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['node'] });
  const result = await provider.execute({
    id: crypto.randomUUID(), capability: 'process.inspect', risk: 'read',
    input: { pid: process.pid, limit: 10 }, provenance: { kind: 'chatgpt' as const }
  });
  assert.equal(result.ok, true, result.error?.message);
  const processes = (result.output as any).processes as any[];
  assert.ok(processes.some((entry) => entry.pid === process.pid));
  for (const entry of processes) {
    assert.equal('commandLine' in entry, false);
    assert.equal('environment' in entry, false);
  }
});


test('Windows process inspection collection queries avoid verbose global tasklist', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only process inspection');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-process-collection-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['node'] });

  const listed = await provider.execute({
    id: crypto.randomUUID(), capability: 'process.inspect', risk: 'read',
    input: { limit: 5 }, provenance: { kind: 'chatgpt' as const }
  });
  assert.equal(listed.ok, true, listed.error?.message);
  assert.ok(((listed.output as any).processes as any[]).length > 0);

  const named = await provider.execute({
    id: crypto.randomUUID(), capability: 'process.inspect', risk: 'read',
    input: { name: 'node', limit: 5 }, provenance: { kind: 'chatgpt' as const }
  });
  assert.equal(named.ok, true, named.error?.message);
  const processes = (named.output as any).processes as any[];
  assert.ok(processes.some((entry) => String(entry.imageName).toLowerCase().includes('node')));
  for (const entry of processes) {
    assert.equal('commandLine' in entry, false);
    assert.equal('environment' in entry, false);
    assert.equal('userName' in entry, false);
    assert.equal('windowTitle' in entry, false);
  }
});


test('Windows process.manage requires fresh identity fingerprint and terminates only current-user target', async (ctx) => {
  if (process.platform !== 'win32') return ctx.skip('Windows-only process management');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-process-manage-'));
  ctx.after(() => fs.rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, windowsHide: true, stdio: 'ignore' });
  assert.ok(child.pid);
  ctx.after(() => { try { child.kill(); } catch {} });
  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['node'] });

  let inspected: any;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await provider.execute({
      id: crypto.randomUUID(), capability: 'process.inspect', risk: 'read',
      input: { pid: child.pid, limit: 10 }, provenance: { kind: 'chatgpt' as const }
    });
    if (result.ok && (result.output as any).processes.length) { inspected = (result.output as any).processes[0]; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(inspected);
  assert.match(inspected.fingerprint, /^[0-9a-f]{64}$/);

  const stale = await provider.execute({
    id: crypto.randomUUID(), capability: 'process.manage', risk: 'destructive',
    input: { operation: 'terminate', pid: child.pid, expectedFingerprint: '0'.repeat(64) },
    provenance: { kind: 'chatgpt' as const }
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error?.code, 'PROCESS_PRECONDITION_FAILED');

  const terminated = await provider.execute({
    id: crypto.randomUUID(), capability: 'process.manage', risk: 'destructive',
    input: { operation: 'terminate', pid: child.pid, expectedFingerprint: inspected.fingerprint },
    provenance: { kind: 'chatgpt' as const }
  });
  assert.equal(terminated.ok, true, terminated.error?.message);
});


test('Windows process termination reconciliation distinguishes still-present from completed exact identity', async (ctx) => {
  if (process.platform !== 'win32') return ctx.skip('Windows-only process reconciliation');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-process-reconcile-'));
  ctx.after(() => fs.rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, windowsHide: true, stdio: 'ignore' });
  assert.ok(child.pid);
  ctx.after(() => { try { child.kill(); } catch {} });
  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['node'] });

  let inspected: any;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await provider.execute({
      id: crypto.randomUUID(), capability: 'process.inspect', risk: 'read',
      input: { pid: child.pid, limit: 10 }, provenance: { kind: 'runtime' as const }
    });
    if (result.ok && (result.output as any).processes.length) { inspected = (result.output as any).processes[0]; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(inspected);

  const action = {
    id: 'process-reconcile-terminate',
    capability: 'process.manage',
    risk: 'destructive' as const,
    input: { operation: 'terminate', pid: child.pid, expectedFingerprint: inspected.fingerprint },
    provenance: { kind: 'runtime' as const }
  };

  const before = await provider.reconcile({ action });
  assert.equal(before.status, 'not_applied');

  const terminated = await provider.execute(action);
  assert.equal(terminated.ok, true, terminated.error?.message);

  const after = await provider.reconcile({ action });
  assert.equal(after.status, 'completed');
  assert.equal(after.result?.ok, true);
  assert.equal((after.result?.output as any).fingerprint, inspected.fingerprint);
});

test('Windows native one-shot Job Object kills detached descendants after a successful parent exit', async t => {
  if (process.platform !== 'win32') return t.skip('Windows Job Object containment regression');
  if (!process.env.OPERATOR_WINDOWS_PATH_LEASE_PATH) return t.skip('native helper unavailable');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-job-close-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'detached-descendant-escaped.txt');
  const descendant = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'survived'),1200)`;
  const parent = `const{spawn}=require('child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'});c.unref();`;
  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['node'] });
  const result = await provider.execute(request('node', ['-e', parent], root));
  assert.equal(result.ok, true, result.error?.message);
  await new Promise(resolve => setTimeout(resolve, 1600));
  await assert.rejects(fs.access(marker), 'detached descendants must be terminated when the Job Object closes');
});

test('Windows one-shot execution rejects missing native Job Object helper by default', async t => {
  if (process.platform !== 'win32') return t.skip('Windows containment configuration');
  const prevHelper = process.env.OPERATOR_WINDOWS_PATH_LEASE_PATH;
  delete process.env.OPERATOR_WINDOWS_PATH_LEASE_PATH;
  t.after(() => {
    if (prevHelper === undefined) delete process.env.OPERATOR_WINDOWS_PATH_LEASE_PATH;
    else process.env.OPERATOR_WINDOWS_PATH_LEASE_PATH = prevHelper;
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-job-required-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'must-not-run.txt');
  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['node'] });
  const result = await provider.execute(request('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`], root));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'PROCESS_JOB_CONTAINMENT_REQUIRED');
  await assert.rejects(fs.access(marker));
});

test('Windows kernel Job Object terminates recursively detached grandchildren on timeout', async t => {
  if (process.platform !== 'win32') return t.skip('Windows nested Job Object containment proof');
  assert.ok(process.env.OPERATOR_WINDOWS_PATH_LEASE_PATH,
    'Windows native containment test requires its built and configured kernel helper');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-job-grandchild-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const started = path.join(root, 'grandchild-started.txt');
  const escaped = path.join(root, 'grandchild-survived.txt');
  // The intermediary is DETACHED and exits after spawning a second DETACHED
  // process. taskkill /T on the original PID could miss the grandchild.
  const grandchild = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},'grandchild-live');setTimeout(()=>fs.writeFileSync(${JSON.stringify(escaped)},'escaped'),5200);setInterval(()=>{},1000)`;
  const intermediary = `const{spawn}=require('child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore'});c.unref()`;
  const parent = `const{spawn}=require('child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(intermediary)}],{detached:true,stdio:'ignore'});c.unref();setInterval(()=>{},1000)`;
  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['node'] });
  const result = await provider.execute({
    id: crypto.randomUUID(), capability: 'terminal.execute', risk: 'destructive',
    input: { executable: 'node', args: ['-e', parent], cwd: root, timeoutMs: 3000 },
    provenance: { kind: 'chatgpt' }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'PROCESS_TIMEOUT');
  await fs.access(started); // The GRANDCHILD itself must have executed before timeout.
  await new Promise(resolve => setTimeout(resolve, 5600));
  await assert.rejects(fs.access(escaped),
    'All descendants, including two-generation detached grandchildren, must remain terminated');
});


test('Windows native one-shot Job Object kills detached descendants when the supervisor itself dies', async t => {
  if (process.platform !== 'win32') return t.skip('Windows Job Object supervisor death regression');
  const helper = process.env.OPERATOR_WINDOWS_PATH_LEASE_PATH;
  assert.ok(helper, 'native Job Object helper must be configured for Windows containment CI');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-job-supervisor-death-'));
  const started = path.join(root, 'detached-child-started.txt');
  const escaped = path.join(root, 'detached-child-survived.txt');
  const descendant = "const fs=require('node:fs');fs.writeFileSync(" + JSON.stringify(started)
    + ",'started');setTimeout(()=>fs.writeFileSync(" + JSON.stringify(escaped)
    + ",'escaped'),1800);setInterval(()=>{},1000)";
  const parent = "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',"
    + JSON.stringify(descendant) + "],{detached:true,stdio:'ignore'});c.unref();setInterval(()=>{},1000)";
  // Test native kernel ownership directly, instead of going through the
  // process provider's normal timeout and graceful completion handlers.
  const supervisor = spawn(helper, ['job-run', root, process.execPath, '-e', parent], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  supervisor.stdout?.resume();
  supervisor.stderr?.resume();
  let spawnError: Error | undefined;
  supervisor.on('error', error => { spawnError = error; });
  t.after(async () => {
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill();
    await fs.rm(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + (process.env.CI === 'true' ? 20_000 : 10_000);
  let observed = false;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    observed = await fs.access(started).then(() => true, () => false);
    if (observed || supervisor.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(observed, 'the detached child must actually start before supervisor termination');
  assert.equal(supervisor.exitCode, null, 'native supervisor must still own the active Job Object');
  const exit = new Promise<void>((resolve, reject) => {
    supervisor.once('exit', () => resolve());
    supervisor.once('error', reject);
  });
  assert.equal(supervisor.kill(), true, 'test must kill the exact native supervisor');
  let exitDeadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      exit,
      new Promise<never>((_, reject) => {
        exitDeadline = setTimeout(() => reject(new Error('native supervisor did not exit within 10s')), 10_000);
      })
    ]);
  } finally {
    if (exitDeadline) clearTimeout(exitDeadline);
  }
  // The child is demonstrably alive before its job owner is killed.
  // The delayed marker catches descendants that escape KILL_ON_JOB_CLOSE.
  await new Promise(resolve => setTimeout(resolve, 2200));
  await assert.rejects(fs.access(escaped),
    'abrupt supervisor death must close the kernel job and kill its detached children');
});

test('Windows native one-shot Job Object contains a burst of independently detached children after supervisor death', async t => {
  if (process.platform !== 'win32') return t.skip('Windows kernel burst containment');
  const helper = process.env.OPERATOR_WINDOWS_PATH_LEASE_PATH;
  assert.ok(helper, 'trusted native Job Object helper must be configured');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-job-burst-'));
  const count = 6;
  const childScript = "const fs=require('node:fs');"
    + "fs.writeFileSync(process.argv[1],'started');"
    + "setTimeout(()=>fs.writeFileSync(process.argv[2],'escaped'),2000);"
    + "setInterval(()=>{},1000)";
  // The supervisor's child keeps spawning new detached descendants, not one
  // fixed process tree. Each must join the same kernel Job Object at creation.
  const parent = "const cp=require('node:child_process');const path=require('node:path');"
    + "const root=" + JSON.stringify(root) + ";"
    + "const script=" + JSON.stringify(childScript) + ";"
    + "let i=0;const timer=setInterval(()=>{const n=i++;"
    + "const child=cp.spawn(process.execPath,['-e',script,path.join(root,'started-'+n),"
    + "path.join(root,'escaped-'+n)],{detached:true,stdio:'ignore'});child.unref();"
    + "if(i>=6)clearInterval(timer);},40);setInterval(()=>{},1000)";
  const supervisor = spawn(helper, ['job-run', root, process.execPath, '-e', parent], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  supervisor.stdout?.resume();
  supervisor.stderr?.resume();
  let spawnError: Error | undefined;
  supervisor.on('error', error => { spawnError = error; });
  t.after(async () => {
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill();
    await fs.rm(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + (process.env.CI === 'true' ? 25_000 : 12_000);
  let started = 0;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const observed = await Promise.all(Array.from({ length: count }, (_, n) =>
      fs.access(path.join(root, 'started-' + n)).then(() => true, () => false)));
    started = observed.filter(Boolean).length;
    if (started === count || supervisor.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(started, count, 'all six detached descendants must have run before the crash injection');
  assert.equal(supervisor.exitCode, null, 'supervisor must still own the kernel Job Object');
  const exited = new Promise<void>((resolve, reject) => {
    supervisor.once('exit', () => resolve());
    supervisor.once('error', reject);
  });
  assert.equal(supervisor.kill(), true, 'terminate exactly the test-owned Job Object supervisor');
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Job Object supervisor did not terminate')), 10_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  await new Promise(resolve => setTimeout(resolve, 2600));
  for (let n = 0; n < count; n += 1) {
    await assert.rejects(fs.access(path.join(root, 'escaped-' + n)),
      'detached descendant ' + n + ' escaped the dead supervisor Job Object');
  }
});

test('C06 trusted terminal invocation and managed session refuse coercible arguments before spawn', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-process-exact-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['node'] });
  t.after(() => provider.close());
  let invoked = 0;
  const imposter = { toString() { invoked++; return 'node'; } };
  const attempts = [
    { capability: 'terminal.execute', input: { executable: ['node'], args: [], cwd: root } },
    { capability: 'terminal.execute', input: { executable: imposter, args: [], cwd: root } },
    { capability: 'terminal.execute', input: { executable: 'node', args: [['-e'], 'process.exit(0)'], cwd: root } },
    { capability: 'terminal.execute', input: { executable: 'node', args: [], cwd: [root] } },
    { capability: 'terminal.session', input: { operation: 'start', executable: ['node'], args: [], cwd: root } },
    { capability: 'terminal.session', input: { operation: 'start', executable: 'node', args: [imposter], cwd: root } },
    { capability: 'terminal.session', input: { operation: 'start', executable: 'node', args: [], cwd: [root] } },
    { capability: 'terminal.session', input: { operation: 'list', developerSessionId: ['trusted'] } },
    { capability: 'terminal.session', input: { operation: 'terminate', sessionId: ['00000000-0000-4000-8000-000000000001'] } },
    { capability: 'terminal.session', input: { operation: 'terminate',
      sessionId: { toString() { invoked++; return '00000000-0000-4000-8000-000000000001'; } } } }
  ];
  for (const [index, item] of attempts.entries()) {
    const result = await provider.execute({
      id: 'coercion-' + index, capability: item.capability,
      risk: item.capability === 'terminal.execute' ? 'destructive' : 'destructive',
      input: item.input, provenance: { kind: 'runtime' }
    } as any);
    assert.equal(result.ok, false, 'case ' + index);
    assert.ok(['PROCESS_INPUT_INVALID', 'DEVELOPER_RUNTIME_SESSION_INVALID'].includes(result.error?.code ?? ''), 'case ' + index);
  }
  assert.equal(invoked, 0, 'No attacker coercion hook may run before terminal authority.');
  assert.throws(() => provider.resolveRisk({
    id: 'risk-array', capability: 'terminal.session', risk: 'read',
    input: { operation: ['list'] }, provenance: { kind: 'runtime' }
  } as any), /terminal.session operation/);
});


test('C06 developer process port declarations reject coercion before any session or executable launch', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-ports-literal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['node'] });
  t.after(() => provider.close());
  let coerced = 0;
  const attacker = {
    valueOf() { coerced++; return 8080; },
    toString() { coerced++; return '8080'; }
  };
  const badPorts: unknown[] = [
    ['8080'], [[8080]], [true], [attacker], [new Number(8080)],
    [1.5], [0], [65536], [Number.NaN], [Infinity], Array(1),
    Array.from({ length: 129 }, () => 8080), '8080'
  ];
  for (const [index, ports] of badPorts.entries()) {
    const result = await provider.execute({
      id: 'bad-port-' + index, capability: 'terminal.session', risk: 'destructive',
      input: { operation: 'start', executable: 'node', args: ['-e', 'process.exit(0)'], cwd: root, ports },
      provenance: { kind: 'runtime' }
    } as any);
    assert.equal(result.ok, false, 'case ' + index);
    assert.equal(result.error?.code, 'DEVELOPER_RUNTIME_PORT_INVALID', 'case ' + index);
    assert.equal(result.error?.sideEffectState, 'none', 'invalid port must fail before process start');
  }
  assert.equal(coerced, 0, 'caller-provided port conversion hooks must never execute');
});
