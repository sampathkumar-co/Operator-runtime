import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { ProcessProvider } from '../src/capabilities/process.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { TerminalSessionStore } from '../src/core/terminal-session-store.ts';

function action(operation: string, input: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(), capability: 'terminal.session',
    risk: operation === 'list' || operation === 'read' ? 'read' as const : 'destructive' as const,
    input: { operation, ...input }, provenance: { kind: 'runtime' as const }
  };
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-terminal-durable-'));
  const state = path.join(root, 'state');
  await fs.mkdir(state);
  return { root, state };
}

async function start(provider: ProcessProvider, root: string, script = 'setInterval(()=>{},1000)') {
  return await provider.execute(action('start', { executable: 'node', args: ['-e', script], cwd: root }));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

async function waitDead(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && alive(pid); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(alive(pid), false, `PID ${pid} remained alive`);
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid || !alive(child.pid)) return;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.kill();
  await waitDead(child.pid);
  await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
}

test('successful terminal start has durable exact ownership before returning', async (t) => {
  const { root, state } = await fixture(t);
  const provider = new ProcessProvider({ stateDir: state, allowedRoots: [root], allowedExecutables: ['node'] });
  t.after(() => provider.close());
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await provider.initialize();
  const result = await start(provider, root);
  assert.equal(result.ok, true, result.error?.message);
  const output = result.output as { sessionId: string; pid: number };
  const record = await new TerminalSessionStore(state).get(output.sessionId);
  assert.equal(record?.state, 'running');
  assert.equal(record?.pid, output.pid);
  assert.equal(record?.processInstance?.pid, output.pid);
  assert.ok(record?.processInstance?.started);
});

test('reconstruction recovers an exact surviving orphan and keeps truthful tombstone semantics', async (t) => {
  const { root, state } = await fixture(t);
  const first = new ProcessProvider({ stateDir: state, allowedRoots: [root], allowedExecutables: ['node'] });
  await first.initialize();
  const started = await start(first, root);
  assert.equal(started.ok, true, started.error?.message);
  const { sessionId, pid } = started.output as { sessionId: string; pid: number };
  assert.equal(alive(pid), true);

  const restarted = new ProcessProvider({ stateDir: state, allowedRoots: [root], allowedExecutables: ['node'] });
  t.after(() => restarted.close());
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await restarted.initialize();
  await waitDead(pid);

  const listed = await restarted.execute(action('list'));
  assert.equal(listed.ok, true);
  const recovered = ((listed.output as { sessions: Array<Record<string, unknown>> }).sessions).find((entry) => entry.sessionId === sessionId);
  assert.equal(recovered?.state, 'recovered');
  assert.equal(recovered?.reattachable, false);

  const read = await restarted.execute(action('read', { sessionId }));
  assert.equal(read.ok, true);
  assert.deepEqual((read.output as { events: unknown[] }).events, []);

  const reconciliation = await restarted.reconcile({ action: action('terminate', { sessionId }) });
  assert.equal(reconciliation.status, 'completed');
  assert.equal(reconciliation.result?.ok, true);
});

test('PID reuse closes stale ownership without killing the replacement', async (t) => {
  const { root, state } = await fixture(t);
  const replacement = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, windowsHide: true, stdio: 'ignore' });
  assert.ok(replacement.pid);
  t.after(() => stopChild(replacement));
  const store = new TerminalSessionStore(state);
  const sessionId = crypto.randomUUID();
  await store.prepare({ sessionId, executable: 'node' });
  const staleStarted = process.platform === 'win32' ? 'windows-filetime:116444736000000000' : process.platform === 'linux' ? 'linux-boot-ticks:1' : 'ps-lstart:Mon Jan 01 00:00:00 2001';
  await store.activate(sessionId, { pid: replacement.pid!, started: staleStarted });

  const provider = new ProcessProvider({ stateDir: state, allowedRoots: [root], allowedExecutables: ['node'] });
  t.after(() => provider.close());
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await provider.initialize();
  assert.equal(alive(replacement.pid!), true);
  assert.equal((await store.get(sessionId))?.state, 'stale_pid');
});

test('unknown process identity fails closed and retains explicit recovery authority', async (t) => {
  const { root, state } = await fixture(t);
  const replacement = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, windowsHide: true, stdio: 'ignore' });
  assert.ok(replacement.pid);
  t.after(() => stopChild(replacement));
  const store = new TerminalSessionStore(state);
  const sessionId = crypto.randomUUID();
  await store.prepare({ sessionId, executable: 'node' });
  await store.activate(sessionId, { pid: replacement.pid!, started: process.platform === 'win32' ? 'windows-filetime:116444736000000000' : 'linux-boot-ticks:1' });
  const provider = new ProcessProvider({
    stateDir: state, allowedRoots: [root], allowedExecutables: ['node'],
    processObserver: async () => ({ status: 'unknown' })
  });
  t.after(() => provider.close());
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await provider.initialize();
  assert.equal(alive(replacement.pid!), true);
  assert.equal((await store.get(sessionId))?.state, 'recovery_required');
});

test('graceful runtime close quiesces exact owned terminal sessions before resolving', async (t) => {
  const { root, state } = await fixture(t);
  const provider = new ProcessProvider({ stateDir: state, allowedRoots: [root], allowedExecutables: ['node'] });
  const runtime = new OperatorRuntime().register(provider);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await runtime.initialize();
  const started = await start(provider, root);
  assert.equal(started.ok, true, started.error?.message);
  const pid = (started.output as { pid: number }).pid;
  await runtime.close();
  assert.equal(alive(pid), false);
});

test('generic runtime emergency stop quiesces a previously completed long-lived session', async (t) => {
  const { root, state } = await fixture(t);
  const provider = new ProcessProvider({ stateDir: state, allowedRoots: [root], allowedExecutables: ['node'] });
  const runtime = new OperatorRuntime().register(provider);
  t.after(() => runtime.close());
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await runtime.initialize();
  const started = await start(provider, root);
  assert.equal(started.ok, true, started.error?.message);
  const pid = (started.output as { pid: number }).pid;
  await runtime.emergencyStop();
  assert.equal(alive(pid), false);
});

test('durable terminal authority excludes args, environment, stdin and output secrets', async (t) => {
  const { root, state } = await fixture(t);
  const secrets = {
    argument: 'ARGUMENT_SECRET_95f8b19c',
    environment: 'ENVIRONMENT_SECRET_8f6d5c4b',
    stdin: 'STDIN_SECRET_3a2b1c0d',
    stdout: 'STDOUT_SECRET_10293847',
    stderr: 'STDERR_SECRET_56473829'
  };
  const previous = process.env.TERMINAL_DURABILITY_SECRET;
  process.env.TERMINAL_DURABILITY_SECRET = secrets.environment;
  t.after(() => { if (previous === undefined) delete process.env.TERMINAL_DURABILITY_SECRET; else process.env.TERMINAL_DURABILITY_SECRET = previous; });
  const provider = new ProcessProvider({ stateDir: state, allowedRoots: [root], allowedExecutables: ['node'] });
  t.after(() => provider.close());
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await provider.initialize();
  const script = `process.stdout.write(${JSON.stringify(secrets.stdout)});process.stderr.write(${JSON.stringify(secrets.stderr)});process.stdin.resume();setInterval(()=>{},1000);//${secrets.argument}`;
  const started = await start(provider, root, script);
  assert.equal(started.ok, true, started.error?.message);
  const sessionId = (started.output as { sessionId: string }).sessionId;
  assert.equal((await provider.execute(action('write', { sessionId, input: secrets.stdin }))).ok, true);
  const raw = await fs.readFile(path.join(state, 'terminal-sessions.json'), 'utf8');
  for (const secret of Object.values(secrets)) assert.equal(raw.includes(secret), false, `persisted ${secret}`);
  assert.equal(raw.includes('args'), false);
});

test('fault before ownership commit never returns success and quiesces the spawned process', async (t) => {
  const { root, state } = await fixture(t);
  let spawnedPid = 0;
  let durableIntentObserved = false;
  const provider = new ProcessProvider({
    stateDir: state, allowedRoots: [root], allowedExecutables: ['node'],
    beforeOwnershipCommit: async ({ sessionId, pid }) => {
      spawnedPid = pid;
      const intent = await new TerminalSessionStore(state).get(sessionId);
      durableIntentObserved = intent?.state === 'launching' && intent.processInstance?.pid === pid;
      throw new Error('injected commit boundary failure');
    }
  });
  t.after(() => provider.close());
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await provider.initialize();
  const result = await start(provider, root);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'TERMINAL_SESSION_START_COMMIT_FAILED');
  assert.ok(spawnedPid > 0);
  assert.equal(durableIntentObserved, true);
  await waitDead(spawnedPid);
  const records = await new TerminalSessionStore(state).list();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.state, 'failed');
});

test('terminal ownership schema rejects corruption and coercion before granting kill authority', async (t) => {
  const { root, state } = await fixture(t);
  const file = path.join(state, 'terminal-sessions.json');
  const replacement = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, windowsHide: true, stdio: 'ignore' });
  assert.ok(replacement.pid);
  t.after(() => stopChild(replacement));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const invalidStates: unknown[] = [
    '{not json',
    { version: 1, sessions: [{ sessionId: crypto.randomUUID(), executable: 'node', pid: String(replacement.pid), processInstance: { pid: replacement.pid, started: 'x' }, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'running', revision: 1 }] },
    { version: 1, sessions: [{ sessionId: crypto.randomUUID(), executable: 'node', pid: -1, processInstance: { pid: -1, started: 'windows-filetime:116444736000000000' }, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'running', revision: 1 }] },
    { version: 1, sessions: [{ sessionId: crypto.randomUUID(), executable: 'node', pid: replacement.pid, processInstance: { pid: replacement.pid, started: 'malformed-fingerprint' }, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'running', revision: 1 }] }
  ];
  for (const invalid of invalidStates) {
    await fs.writeFile(file, typeof invalid === 'string' ? invalid : JSON.stringify(invalid));
    const provider = new ProcessProvider({ stateDir: state, allowedRoots: [root], allowedExecutables: ['node'] });
    await assert.rejects(provider.initialize(), (error: any) => error?.code === 'TERMINAL_SESSION_OWNERSHIP_CORRUPT');
    assert.equal(alive(replacement.pid!), true);
  }
});

test('terminal ownership rejects duplicate IDs, backward transitions and hard-linked authority files', async (t) => {
  const { root, state } = await fixture(t);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new TerminalSessionStore(state);
  const sessionId = crypto.randomUUID();
  await store.prepare({ sessionId, executable: 'node' });
  await store.transition(sessionId, 'failed', { reason: 'test terminal state' });
  await assert.rejects(store.transition(sessionId, 'running', { identity: { pid: 123, started: 'x' } }), (error: any) => error?.code === 'TERMINAL_SESSION_STATE_INVALID');

  const timestamp = new Date().toISOString();
  await fs.writeFile(store.file, JSON.stringify({ version: 1, sessions: [
    { sessionId, executable: 'node', startedAt: timestamp, updatedAt: timestamp, state: 'failed', revision: 1 },
    { sessionId, executable: 'node', startedAt: timestamp, updatedAt: timestamp, state: 'failed', revision: 1 }
  ] }));
  await assert.rejects(store.list(), (error: any) => error?.code === 'TERMINAL_SESSION_OWNERSHIP_CORRUPT');

  await fs.writeFile(store.file, JSON.stringify({ version: 1, sessions: [] }));
  const alias = path.join(state, 'terminal-sessions-hardlink.json');
  await fs.link(store.file, alias);
  t.after(() => fs.rm(alias, { force: true }));
  await assert.rejects(store.list(), (error: any) => error?.code === 'TERMINAL_SESSION_OWNERSHIP_CORRUPT');
});


test('boot-bound Linux process identities survive durable terminal ownership validation', async (t) => {
  const { root, state } = await fixture(t);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new TerminalSessionStore(state);
  const sessionId = crypto.randomUUID();
  await store.prepare({ sessionId, executable: process.execPath });
  const identity = {
    pid: 12345,
    started: 'linux-boot-id:12345678-1234-1234-1234-123456789abc:ticks:987654'
  };
  const active = await store.activate(sessionId, identity);
  assert.deepEqual(active.processInstance, identity);
  const persisted = await new TerminalSessionStore(state).get(sessionId);
  assert.deepEqual(persisted?.processInstance, identity);

  const invalidSession = crypto.randomUUID();
  await store.prepare({ sessionId: invalidSession, executable: process.execPath });
  await assert.rejects(
    store.activate(invalidSession, { ...identity, started: 'linux-boot-id:garbage:ticks:987654' }),
    (error: any) => error?.code === 'TERMINAL_SESSION_OWNERSHIP_CORRUPT'
  );
});
