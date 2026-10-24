import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EvaluationStore, evaluationRunFromTask } from '../src/core/evaluation.ts';
import { createTask } from '../src/core/task.ts';
import type { TaskCapsule } from '../src/core/task.ts';

const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
function failedTask(): TaskCapsule {
  const task = createTask({
    userObjective: 'submit synthetic form',
    interpretedObjective: 'submit synthetic form',
    authorizedScope: ['browser:https://fixture.invalid'], prohibitedScope: [],
    successConditions: ['server acknowledged form']
  });
  task.state = 'FAILED';
  task.execution = {
    schemaVersion: 1, plannerId: 'model-neutral', goalKind: 'form',
    plannerState: {}, maxSteps: 3, maxAttemptsPerStep: 1, timeoutMs: 10_000,
    stepCount: 1, startedAt: '2026-10-24T00:00:00.000Z', records: []
  };
  task.updatedAt = '2026-10-24T00:00:01.000Z';
  return task;
}
function record(task: TaskCapsule, claimedSuccess?: boolean) {
  return evaluationRunFromTask({
    id: crypto.randomUUID(), scenarioId: 'browser.synthetic-form', scenarioVersion: 1,
    runtimeVersion: '2.0.6', sourceCommit: 'a'.repeat(40),
    candidateDirty: false, runnerHash: digest('runner'), task, seed: 1,
    model: 'model-test', provider: 'provider-test',
    modelConfigDigest: digest('config'), environmentDigest: digest('fixture'),
    ...(claimedSuccess === undefined ? {} : { claimedSuccess })
  });
}

test('model claim does not promote a failed task to independently verified success', () => {
  const unverified = failedTask();
  const run = record(unverified, true);
  assert.equal(run.claimedSuccess, true);
  assert.equal(run.verifiedSuccess, false);
  assert.equal(run.verificationState, 'pending');
});

test('native evaluation records false completion accurately in the persisted store', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-claim-vs-proof-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new EvaluationStore(dir);
  await store.registerScenario({
    id: 'browser.synthetic-form', version: 1, category: 'browser',
    title: 'Verify synthetic submission', contractDigest: digest('submission'),
    requiredCapabilities: ['browser.interact'], chaosTags: [],
    createdAt: '2026-10-24T00:00:00.000Z'
  });
  const run = record(failedTask(), true);
  await store.recordRun(run);
  const summary = await store.summary({ sourceCommit: 'a'.repeat(40) });
  assert.equal(summary.runs, 1);
  assert.equal(summary.claimedSuccesses, 1);
  assert.equal(summary.verifiedSuccesses, 0);
  assert.equal(summary.falseSuccesses, 1);
  assert.equal(summary.falseSuccessRate, 1);
});

test('verified completion is computed from task truth even when model does not claim success', () => {
  const task = failedTask();
  task.state = 'VERIFIED';
  const run = record(task, false);
  assert.equal(run.claimedSuccess, false);
  assert.equal(run.verifiedSuccess, true);
});

test('legacy native evaluator still derives claim from task state when omitted', () => {
  const run = record(failedTask());
  assert.equal(run.claimedSuccess, false);
  assert.equal(run.verifiedSuccess, false);
});

test('non-boolean model completion claim fails closed', () => {
  const task = failedTask();
  assert.throws(
    () => evaluationRunFromTask({
      id: crypto.randomUUID(), scenarioId: 'browser.synthetic-form',
      scenarioVersion: 1, runtimeVersion: '2.0.6', sourceCommit: 'a'.repeat(40),
      candidateDirty: false, runnerHash: digest('runner'), task, seed: 1,
      model: 'model-test', provider: 'provider-test',
      modelConfigDigest: digest('config'), environmentDigest: digest('fixture'),
      claimedSuccess: 'true' as unknown as boolean
    }),
    (error: any) => error?.code === 'EVALUATION_INPUT_INVALID'
  );
});
