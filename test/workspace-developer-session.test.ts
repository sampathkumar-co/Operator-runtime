import assert from 'node:assert/strict';
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
