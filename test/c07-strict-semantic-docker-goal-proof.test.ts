import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createTask, type TaskCapsule } from '../src/core/task.ts';
import { verifyGoalOutcomeTruth, verifyTaskCompletion } from '../src/core/task-verifier.ts';

const digest = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
function fixture(): TaskCapsule {
  return createTask({
    userObjective: 'Restart the registered web service',
    interpretedObjective: 'Restart the registered web service and inspect its state',
    authorizedScope: ['fixture-docker-project'], prohibitedScope: [],
    successConditions: ['The web service is running in the registered project'],
    execution: {
      schemaVersion: 1, plannerId: 'operator.semantic.v1',
      goalKind: 'docker-lifecycle',
      plannerState: {
        phase: 'complete', goal: { kind: 'docker-lifecycle', operation: 'restart', services: ['web'] }
      },
      maxSteps: 10, maxAttemptsPerStep: 2, timeoutMs: 30_000, stepCount: 1,
      records: [{
        stepKey: 'verify-docker-project', actionId: 'verify-docker-1',
        capability: 'docker.inspect', risk: 'read', inputHash: 'a'.repeat(64),
        attempt: 0, state: 'SUCCEEDED',
        startedAt: '2026-10-25T10:00:00.000Z',
        finishedAt: '2026-10-25T10:00:00.150Z',
        evidence: [{
          kind: 'provider_execution', status: 'pass',
          message: 'Synthetic project scoped inspection',
          timestamp: '2026-10-25T10:00:00.100Z'
        }],
        observation: {
          schemaVersion: 2, channel: 'semantic', domain: 'docker',
          provider: 'synthetic', capability: 'docker.inspect',
          entityId: 'docker:fixture', observedAt: '2026-10-25T10:00:00.100Z',
          stateVersion: digest('fresh-registered-project-inspection'),
          importantState: {
            scope: 'project', services: [{ service: 'web', states: ['running'] }]
          },
          epistemicStatus: 'KNOWN', epistemicReason: '', ambiguous: false,
          confidence: 1, evidenceRefs: ['b'.repeat(64)]
        }
      }]
    }
  });
}
function goal(task: TaskCapsule): Record<string, unknown> {
  return task.execution!.plannerState.goal as Record<string, unknown>;
}
test('C07 legitimate typed Docker restart still has independent project-state evidence', () => {
  const task = fixture();
  const truth = verifyGoalOutcomeTruth(task);
  assert.equal(truth.supported, true);
  assert.equal(truth.ok, true);
});
test('C07 unsupported Docker operation must not borrow the running postcondition of start', () => {
  for (const operation of ['resume', ['restart'], { toString: () => 'restart' }, null]) {
    const task = fixture();
    goal(task).operation = operation;
    const truth = verifyGoalOutcomeTruth(task);
    assert.equal(truth.supported, true);
    assert.equal(truth.ok, false, 'operation=' + String(typeof operation));
  }
});
test('C07 Docker service and observed state identities must be literal typed strings', () => {
  const badService = fixture();
  goal(badService).services = [['web']];
  assert.equal(verifyGoalOutcomeTruth(badService).ok, false);

  const missingService = fixture();
  goal(missingService).services = [null];
  assert.equal(verifyGoalOutcomeTruth(missingService).ok, false);

  const badState = fixture();
  const observation = badState.execution!.records[0]!.observation;
  if (observation?.schemaVersion !== 2) throw Error('Fixture must contain a known machine observation');
  observation.importantState = { scope: 'project',
    services: [{ service: 'web', states: [['running']] }] };
  assert.equal(verifyGoalOutcomeTruth(badState).ok, false);
});
test('C07 built-in semantic planner cannot mark an unknown or type-confused goal kind as verified', () => {
  for (const kind of ['unsupported-new-operation', ['docker-lifecycle'], null]) {
    const task = fixture();
    goal(task).kind = kind;
    const truth = verifyGoalOutcomeTruth(task);
    assert.equal(truth.supported, true);
    assert.equal(truth.ok, false);
    const completion = verifyTaskCompletion(task);
    assert.equal(completion.ok, false);
    assert.equal(completion.bundle.checks.find(check =>
      check.name === 'typed-goal-outcome-truth')?.ok, false);
  }
});
