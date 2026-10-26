import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDeveloperSession, DeveloperSessionStore, updateDeveloperSession }
  from '../src/core/developer-session.ts';

test('C08 newer timestamp cannot overwrite a session changed after its exact snapshot was observed', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-review-snapshot-cas-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = new DeveloperSessionStore(root);
  const b = new DeveloperSessionStore(root);
  const initial = createDeveloperSession({
    objective: 'Protect exact recovery snapshot during concurrent work',
    acceptanceCriteria: ['No stale review evidence overrides current state'],
    workspaceRootNodeId: 'authorized-root',
    now: '2026-10-26T00:00:00.000Z'
  });
  await a.put(initial);
  const staleSnapshot = await a.get(initial.id);
  const newState = updateDeveloperSession(initial, {
    status:'ACTIVE',taskIds:['new-task']
  }, '2026-10-26T00:00:10.000Z');
  await b.put(newState, staleSnapshot);
  const staleWithFutureTime = updateDeveloperSession(staleSnapshot, {
    status:'PAUSED',taskIds:['old-task']
  }, '2026-10-26T00:00:20.000Z');
  await assert.rejects(a.put(staleWithFutureTime, staleSnapshot),
    (err: any) => err?.code === 'DEVELOPER_SESSION_STALE_WRITE');
  assert.deepEqual(await b.get(initial.id), newState);
  const next = updateDeveloperSession(newState, {
    status:'VERIFYING',taskIds:['new-task']
  }, '2026-10-26T00:00:21.000Z');
  await a.put(next, newState);
  assert.deepEqual(await b.get(initial.id), next);
});

test('C08 expected snapshot must belong to the exact developer-session identity', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-review-cross-session-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DeveloperSessionStore(root);
  const a = createDeveloperSession({ objective:'Session A',
    acceptanceCriteria:['A'],workspaceRootNodeId:'root' });
  const b = createDeveloperSession({ objective:'Session B',
    acceptanceCriteria:['B'],workspaceRootNodeId:'root' });
  await store.put(a);
  await assert.rejects(store.put(updateDeveloperSession(a, {status:'ACTIVE'}), b),
    (err: any) => err?.code === 'DEVELOPER_SESSION_STALE_WRITE');
});
