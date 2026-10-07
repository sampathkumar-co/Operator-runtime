import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { ProcessProvider } from '../src/capabilities/process.ts';
import {
  createDeveloperSession,
  DeveloperSessionStore,
  updateDeveloperSession
} from '../src/core/developer-session.ts';
import { resourceKeysForAction } from '../src/core/resource-identity.ts';
import type { ActionRequest } from '../src/core/types.ts';

async function fixture(t: TestContext) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-dev-process-'));
  t.after(async () => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'workspace');
  const stateDir = path.join(parent, 'state');
  await fs.mkdir(root);
  await fs.mkdir(stateDir);
  const sessions = new DeveloperSessionStore(stateDir);
  const created = createDeveloperSession({
    objective: 'Run a durable development service',
    acceptanceCriteria: ['Owned process can be recovered and terminated after provider restart.'],
    workspaceRootNodeId: 'workspace-root',
    now: '2026-10-06T00:00:00.000Z'
  });
  const active = updateDeveloperSession(
    created,
    { status: 'ACTIVE' },
    '2026-10-06T00:00:01.000Z'
  );
  await sessions.put(active);
  return { parent, root, stateDir, session: active };
}

function sessionAction(
  operation: 'start' | 'list' | 'read' | 'write' | 'terminate',
  input: Record<string, unknown>
): ActionRequest {
  return {
    id: crypto.randomUUID(),
    capability: 'terminal.session',
    risk: operation === 'list' || operation === 'read' ? 'read' : 'destructive',
    input: { operation, ...input },
    provenance: { kind: 'runtime' }
  };
}

test('Developer Session process survives provider restart as detached durable ownership and can be terminated exactly', async (t) => {
  const fx = await fixture(t);
  const provider1 = new ProcessProvider({
    allowedRoots: [fx.root],
    allowedExecutables: [process.execPath],
    requiredRisk: 'destructive',
    stateDir: fx.stateDir
  });
  t.after(async () => provider1.close());

  const start = await provider1.execute(sessionAction('start', {
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: fx.root,
    developerSessionId: fx.session.id,
    ports: [43123]
  }));
  assert.equal(start.ok, true);
  const started = start.output as {
    sessionId: string;
    pid: number;
    developerSessionId: string;
    durableOwned: boolean;
    ports: number[];
  };
  assert.equal(started.developerSessionId, fx.session.id);
  assert.equal(started.durableOwned, true);
  assert.deepEqual(started.ports, [43123]);

  const provider2 = new ProcessProvider({
    allowedRoots: [fx.root],
    allowedExecutables: [process.execPath],
    requiredRisk: 'destructive',
    stateDir: fx.stateDir
  });
  t.after(async () => provider2.close());

  const listed = await provider2.execute(sessionAction('list', {
    developerSessionId: fx.session.id
  }));
  assert.equal(listed.ok, true);
  const listedRows = (listed.output as { sessions: Array<Record<string, unknown>> }).sessions;
  const detached = listedRows.find((item) => item.sessionId === started.sessionId);
  assert.ok(detached);
  assert.equal(detached?.state, 'detached-running');
  assert.equal(detached?.durableOwned, true);
  assert.deepEqual(detached?.ports, [43123]);

  const read = await provider2.execute(sessionAction('read', {
    sessionId: started.sessionId
  }));
  assert.equal(read.ok, false);
  assert.equal(read.error?.code, 'SESSION_DETACHED_AFTER_RESTART');

  const terminated = await provider2.execute(sessionAction('terminate', {
    sessionId: started.sessionId
  }));
  assert.equal(terminated.ok, true);
  assert.equal((terminated.output as { state?: string }).state, 'terminated');

  const after = await provider2.execute(sessionAction('list', {
    developerSessionId: fx.session.id
  }));
  const afterRow = (after.output as { sessions: Array<Record<string, unknown>> }).sessions
    .find((item) => item.sessionId === started.sessionId);
  assert.equal(afterRow?.state, 'terminated');

  const secondStart = await provider2.execute(sessionAction('start', {
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: fx.root,
    developerSessionId: fx.session.id,
    ports: [43123]
  }));
  assert.equal(secondStart.ok, true);
  const secondId = (secondStart.output as { sessionId: string }).sessionId;
  await provider2.execute(sessionAction('terminate', { sessionId: secondId }));
});

test('declared ports are rejected before spawn when another durable Developer Session owns them', async (t) => {
  const fx = await fixture(t);
  const provider = new ProcessProvider({
    allowedRoots: [fx.root],
    allowedExecutables: [process.execPath],
    requiredRisk: 'destructive',
    stateDir: fx.stateDir
  });
  t.after(async () => provider.close());

  const first = await provider.execute(sessionAction('start', {
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: fx.root,
    developerSessionId: fx.session.id,
    ports: [44123]
  }));
  assert.equal(first.ok, true);

  const secondSessionStore = new DeveloperSessionStore(fx.stateDir);
  const second = updateDeveloperSession(
    createDeveloperSession({
      objective: 'Second session',
      acceptanceCriteria: ['No port collision.'],
      workspaceRootNodeId: 'workspace-root',
      now: '2026-10-06T00:01:00.000Z'
    }),
    { status: 'ACTIVE' },
    '2026-10-06T00:01:01.000Z'
  );
  await secondSessionStore.put(second);

  const conflict = await provider.execute(sessionAction('start', {
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: fx.root,
    developerSessionId: second.id,
    ports: [44123]
  }));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error?.code, 'DEVELOPER_RUNTIME_PORT_BUSY');

  await provider.execute(sessionAction('terminate', {
    sessionId: (first.output as { sessionId: string }).sessionId
  }));
});

test('Developer Session-bound process start requires ACTIVE or VERIFYING status', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-dev-process-status-'));
  t.after(async () => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'workspace');
  const stateDir = path.join(parent, 'state');
  await fs.mkdir(root);
  await fs.mkdir(stateDir);

  const store = new DeveloperSessionStore(stateDir);
  const planning = createDeveloperSession({
    objective: 'Planning only',
    acceptanceCriteria: ['Do not execute yet.'],
    workspaceRootNodeId: 'workspace-root'
  });
  await store.put(planning);

  const provider = new ProcessProvider({
    allowedRoots: [root],
    allowedExecutables: [process.execPath],
    requiredRisk: 'destructive',
    stateDir
  });
  t.after(async () => provider.close());

  const result = await provider.execute(sessionAction('start', {
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: root,
    developerSessionId: planning.id,
    ports: [45123]
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'DEVELOPER_SESSION_NOT_EXECUTABLE');
});

test('declared ports require durable Developer Session binding and enter canonical resource identity', () => {
  const action = sessionAction('start', {
    executable: process.execPath,
    args: [],
    cwd: '/workspace',
    ports: [3000, 3001]
  });
  const keys = resourceKeysForAction(action);
  assert.ok(keys.includes('network:tcp:3000'));
  assert.ok(keys.includes('network:tcp:3001'));
});
