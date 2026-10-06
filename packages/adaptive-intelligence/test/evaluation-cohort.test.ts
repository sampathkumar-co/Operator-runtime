import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTaskCohortManifest,
  verifyTaskCohortManifest
} from '../src/index.ts';

test('task cohort digest is deterministic regardless of input ordering',()=>{
  const one=createTaskCohortManifest(['task-c','task-a','task-b']);
  const two=createTaskCohortManifest(['task-b','task-c','task-a']);
  assert.equal(one.cohortDigest,two.cohortDigest);
  assert.deepEqual(one.taskIds,['task-a','task-b','task-c']);
  assert.equal(one.taskCount,3);
  assert.equal(verifyTaskCohortManifest(one),true);
});

test('task cohort rejects duplicates rather than silently deduplicating',()=>{
  assert.throws(
    ()=>createTaskCohortManifest(['task-a','task-a']),
    /must be unique/
  );
});

test('task cohort rejects runtime type coercion',()=>{
  assert.throws(
    ()=>createTaskCohortManifest(['task-a',123 as any]),
    /taskId must be a string/
  );
});

test('task cohort verification rejects reordered or count-tampered manifests',()=>{
  const manifest=createTaskCohortManifest(['task-a','task-b','task-c']);
  assert.equal(verifyTaskCohortManifest({
    ...manifest,
    taskIds:[...manifest.taskIds].reverse()
  }),false);
  assert.equal(verifyTaskCohortManifest({
    ...manifest,
    taskCount:99
  }),false);
});

test('task cohort verification rejects digest tampering',()=>{
  const manifest=createTaskCohortManifest(['task-a','task-b']);
  assert.equal(verifyTaskCohortManifest({
    ...manifest,
    cohortDigest:'f'.repeat(64)
  }),false);
});
