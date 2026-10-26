import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeveloperSession, normalizeDeveloperSession } from '../src/core/developer-session.ts';

test('C08 durable session plan, timestamps, digest and resource scope reject JSON type coercion', () => {
  const original = createDeveloperSession({
    objective: 'Safely inspect an authorized project',
    acceptanceCriteria: ['Independent goal evidence exists'],
    workspaceRootNodeId: 'trusted-root',
    now: '2026-10-26T00:00:00.000Z'
  });
  const digest = 'a'.repeat(64);
  const valid = normalizeDeveloperSession({
    ...original,
    workspaceGraphId: digest,
    planRef: { taskId: 'task-1', revision: 7 },
    artifactIds: [digest],
    activeResourceKeys: ['root-one'],
    updatedAt: '2026-10-26T00:00:01.000Z'
  });
  assert.equal(valid.planRef?.revision, 7);
  assert.deepEqual(valid.activeResourceKeys, ['root-one']);
  const attempts: Array<[string, unknown]> = [
    ['planRef.revision as a string', { ...valid, planRef: { taskId:'task-1', revision:'7' } }],
    ['planRef.revision as a singleton array', { ...valid, planRef: { taskId:'task-1', revision:[7] } }],
    ['workspaceGraphId array', { ...valid, workspaceGraphId:[digest] }],
    ['artifact digest array', { ...valid, artifactIds:[[digest]] }],
    ['activeResourceKeys array', { ...valid, activeResourceKeys:[['root-one']] }],
    ['createdAt array', { ...valid, createdAt:['2026-10-26T00:00:00.000Z'] }],
    ['updatedAt array', { ...valid, updatedAt:['2026-10-26T00:00:01.000Z'] }]
  ];
  for (const [label, malformed] of attempts) {
    assert.throws(() => normalizeDeveloperSession(malformed),
      (error: any) => error?.code === 'DEVELOPER_SESSION_INVALID', label);
  }
});
