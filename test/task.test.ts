import assert from 'node:assert/strict';
import test from 'node:test';
import { addTaskNode, createTask, finalizeTask, setNodeState } from '../src/core/task.ts';

test('task graph cannot run dependent work before prerequisite verification', () => {
  const task = createTask({
    userObjective: 'Fix export', interpretedObjective: 'Fix export', authorizedScope: ['repo'], prohibitedScope: ['unrelated files'], successConditions: ['export valid']
  });
  const reproduce = addTaskNode(task, 'reproduce');
  const patch = addTaskNode(task, 'patch', { dependsOn: [reproduce.id] });
  assert.throws(() => setNodeState(task, patch.id, 'RUNNING'), /unverified dependency/);
  setNodeState(task, reproduce.id, 'VERIFIED');
  setNodeState(task, patch.id, 'RUNNING');
  setNodeState(task, patch.id, 'VERIFIED');
  finalizeTask(task);
  assert.equal(task.state, 'VERIFIED');
});
