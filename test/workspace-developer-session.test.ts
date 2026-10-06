import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorkspaceGraph, normalizeWorkspaceGraph, workspaceNeighbors } from '../src/core/workspace-graph.ts';
import { createDeveloperSession, DeveloperSessionStore, updateDeveloperSession } from '../src/core/developer-session.ts';

test('Workspace Graph is an immutable content-addressed projection with validated edges', () => {
  const graph = createWorkspaceGraph({
    rootNodeId: 'workspace:root',
    sourceWorldRevision: 'world:42',
    observedAt: '2026-10-06T00:00:00.000Z',
    nodes: [
      { id: 'workspace:root', kind: 'workspace', label: 'Operator Runtime', metadata: {} },
      { id: 'repo:operator', kind: 'repository', label: 'Operator-runtime', revision: 'abc123', metadata: {} },
      { id: 'test:core', kind: 'test', label: 'core suite', metadata: { passed: true } }
    ],
    edges: [
      { from: 'workspace:root', to: 'repo:operator', kind: 'contains', metadata: {} },
      { from: 'test:core', to: 'repo:operator', kind: 'verifies', metadata: {} }
    ]
  });
  assert.match(graph.id, /^[0-9a-f]{64}$/);
  assert.deepEqual(workspaceNeighbors(graph, 'repo:operator').map((node) => node.id), ['test:core', 'workspace:root']);
  assert.equal(normalizeWorkspaceGraph(graph).id, graph.id);
});

test('Workspace Graph refuses edges to entities not present in the projection', () => {
  assert.throws(() => createWorkspaceGraph({
    rootNodeId: 'workspace:root',
    observedAt: '2026-10-06T00:00:00.000Z',
    nodes: [{ id: 'workspace:root', kind: 'workspace', label: 'Root', metadata: {} }],
    edges: [{ from: 'workspace:root', to: 'missing', kind: 'contains', metadata: {} }]
  }), /unknown node/);
});

test('Developer Session survives durable pause/resume state', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-session-'));
  t.after(async () => fs.rm(dir, { recursive: true, force: true }));
  const store = new DeveloperSessionStore(dir);
  const session = createDeveloperSession({
    objective: 'Refactor the parser without changing behavior.',
    acceptanceCriteria: ['Existing parser tests pass.', 'No public API changes.'],
    constraints: ['No destructive Git operations.'],
    workspaceRootNodeId: 'workspace:root',
    now: '2026-10-06T00:00:00.000Z'
  });
  const graphId = 'a'.repeat(64);
  const artifactId = 'b'.repeat(64);
  const paused = updateDeveloperSession(session, {
    workspaceGraphId: graphId,
    taskIds: ['task-1'],
    artifactIds: [artifactId],
    status: 'PAUSED',
    resumeSummary: 'Parser refactor is staged; run focused tests next.'
  }, '2026-10-06T00:01:00.000Z');
  await store.put(paused);
  const restored = await store.get(paused.id);
  assert.equal(restored.status, 'PAUSED');
  assert.equal(restored.workspaceGraphId, graphId);
  assert.deepEqual(restored.artifactIds, [artifactId]);
  assert.match(restored.resumeSummary ?? '', /focused tests/);
});

test('Developer Session requires acceptance criteria', () => {
  assert.throws(() => createDeveloperSession({
    objective: 'Do something',
    acceptanceCriteria: [],
    workspaceRootNodeId: 'workspace:root',
    now: '2026-10-06T00:00:00.000Z'
  }), /acceptanceCriteria is invalid/);
});


test('Developer Session storage hashes path-like IDs instead of using them as filenames', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-session-storage-'));
  t.after(async () => fs.rm(stateDir, { recursive: true, force: true }));

  const store = new DeveloperSessionStore(stateDir);
  const base = createDeveloperSession({
    objective: 'Verify storage path isolation.',
    acceptanceCriteria: ['Session remains retrievable.'],
    workspaceRootNodeId: 'workspace:root',
    now: '2026-10-06T00:00:00.000Z'
  });
  const session = {
    ...base,
    id: '../escape/session'
  };
  await store.put(session);

  const expectedName = crypto.createHash('sha256')
    .update(session.id, 'utf8')
    .digest('hex') + '.json';
  const sessionDir = path.join(stateDir, 'developer-sessions');
  assert.deepEqual(await fs.readdir(sessionDir), [expectedName]);
  assert.equal((await store.get(session.id)).id, session.id);
  await assert.rejects(
    fs.stat(path.join(stateDir, 'escape')),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
});

test('Developer Session storage remains backward-readable for safe legacy filenames', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-session-legacy-'));
  t.after(async () => fs.rm(stateDir, { recursive: true, force: true }));

  const sessionDir = path.join(stateDir, 'developer-sessions');
  await fs.mkdir(sessionDir, { recursive: true });
  const base = createDeveloperSession({
    objective: 'Read a legacy session.',
    acceptanceCriteria: ['Legacy state remains readable.'],
    workspaceRootNodeId: 'workspace:root',
    now: '2026-10-06T00:00:00.000Z'
  });
  const legacy = { ...base, id: 'legacy-session-1' };
  await fs.writeFile(
    path.join(sessionDir, legacy.id + '.json'),
    JSON.stringify(legacy),
    'utf8'
  );

  const store = new DeveloperSessionStore(stateDir);
  const restored = await store.get(legacy.id);
  assert.equal(restored.id, legacy.id);
  assert.equal(restored.objective, legacy.objective);
});

test('Developer Session list reads hashed records by content identity', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-session-list-'));
  t.after(async () => fs.rm(stateDir, { recursive: true, force: true }));

  const store = new DeveloperSessionStore(stateDir);
  const first = createDeveloperSession({
    objective: 'First',
    acceptanceCriteria: ['A'],
    workspaceRootNodeId: 'workspace:root',
    now: '2026-10-06T00:00:00.000Z'
  });
  const second = createDeveloperSession({
    objective: 'Second',
    acceptanceCriteria: ['B'],
    workspaceRootNodeId: 'workspace:root',
    now: '2026-10-06T00:01:00.000Z'
  });
  await store.put(first);
  await store.put(second);

  const listed = await store.list();
  assert.deepEqual(listed.map((item) => item.id), [second.id, first.id]);
});
