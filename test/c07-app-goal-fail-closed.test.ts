import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createTask, type TaskActionRecord, type TaskCapsule } from '../src/core/task.ts';
import { verifyGoalOutcomeTruth } from '../src/core/task-verifier.ts';

const digest = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const BASE = '2026-10-25T00:00:00.';
const time = (ms: number) => BASE + String(ms).padStart(3, '0') + 'Z';

function observation(stepKey: string, start: number, end: number, snapshot: Record<string, unknown>): TaskActionRecord {
  return {
    stepKey, actionId: stepKey + '-' + start, capability: 'app.inspect', risk: 'read',
    inputHash: 'a'.repeat(64), attempt: 0, state: 'SUCCEEDED',
    startedAt: time(start), finishedAt: time(end), evidence: [],
    observation: {
      schemaVersion: 2, channel: 'semantic', domain: 'uia', provider: 'synthetic',
      capability: 'app.inspect', entityId: 'uia:editor', observedAt: time(start + 10),
      stateVersion: digest(stepKey + start), importantState: snapshot,
      epistemicStatus: 'KNOWN', epistemicReason: '', ambiguous: false,
      confidence: 1, evidenceRefs: ['b'.repeat(64)]
    }
  };
}

function mutation(stepKey: string, start: number, state: TaskActionRecord['state'], verified = false): TaskActionRecord {
  return {
    stepKey, actionId: stepKey + '-' + start,
    capability: stepKey.includes('physical') ? 'input.operate' : 'app.operate',
    risk: 'external', inputHash: 'a'.repeat(64), attempt: 0, state,
    startedAt: time(start), ...(state !== 'STARTED' ? { finishedAt: time(start + 50) } : {}),
    evidence: [],
    ...(state === 'SUCCEEDED' ? { observation: {
      schemaVersion: 2 as const, channel: 'semantic' as const, domain: 'uia' as const,
      provider: 'synthetic', capability: 'app.operate', entityId: 'uia:editor',
      observedAt: time(start + 10), stateVersion: digest(stepKey + start),
      importantState: { postcondition: { verified } },
      epistemicStatus: 'KNOWN' as const, epistemicReason: '', ambiguous: false,
      confidence: 1, evidenceRefs: ['b'.repeat(64)]
    } } : {})
  };
}

function fixture(): TaskCapsule {
  const elements = [{ automationIdHash: digest('editor'), valueHash: digest('ready') }];
  return createTask({
    userObjective: 'Leave the editor value set to ready',
    interpretedObjective: 'Set the editor to ready',
    authorizedScope: ['fixture'], prohibitedScope: [], successConditions: ['editor value is ready'],
    execution: {
      schemaVersion: 1, plannerId: 'operator.semantic.v1', goalKind: 'app-operation',
      plannerState: { phase: 'complete', goal: {
        kind: 'app-operation', operation: 'set_value',
        selector: { automationId: 'editor' }, value: 'ready'
      } },
      maxSteps: 10, maxAttemptsPerStep: 2, timeoutMs: 30_000, stepCount: 1,
      records: [observation('inspect-app-target', 0, 100, { uiaElements: elements })]
    }
  });
}

test('C07 a known, fresh, read-only initial matching value remains a valid no-op', () => {
  const task = fixture();
  assert.equal(verifyGoalOutcomeTruth(task).ok, true);
});

test('C07 attempted mutation or verification cannot fall back to initial value', () => {
  for (const [stepKey, state] of [
    ['operate-app-target', 'FAILED'],
    ['operate-app-target', 'SUCCEEDED'],
    ['operate-app-physical-fallback', 'BLOCKED'],
    ['operate-app-physical-fallback', 'FAILED'],
    ['verify-app-target', 'FAILED'],
    ['verify-app-target', 'STARTED']
  ] as Array<[string, TaskActionRecord['state']]>) {
    const task = fixture();
    task.execution!.records.push(mutation(stepKey, 200, state, true));
    assert.equal(verifyGoalOutcomeTruth(task).ok, false, stepKey + ':' + state);
  }
});

test('C07 post-operation UIA proof requires a causally later known semantic observation', () => {
  const task = fixture();
  task.execution!.records.push(mutation('operate-app-target', 200, 'SUCCEEDED', true));
  const snapshot = { uiaElements: [{ automationIdHash: digest('editor'), valueHash: digest('ready') }] };
  const verify = observation('verify-app-target', 300, 400, snapshot);
  task.execution!.records.push(verify);
  assert.equal(verifyGoalOutcomeTruth(task).ok, true);
  task.execution!.records.push(mutation('operate-app-target', 450, 'FAILED'));
  assert.equal(verifyGoalOutcomeTruth(task).ok, false, 'a newer failed mutation supersedes verified state');
  task.execution!.records.pop();

  // A successful but pre-action read cannot establish the post-action effect.
  verify.startedAt = time(150);
  verify.finishedAt = time(190);
  if (verify.observation?.schemaVersion === 2) verify.observation.observedAt = time(160);
  assert.equal(verifyGoalOutcomeTruth(task).ok, false);

  verify.startedAt = time(300);
  verify.finishedAt = time(400);
  if (verify.observation?.schemaVersion === 2) {
    verify.observation.observedAt = time(310);
    verify.observation.epistemicStatus = 'AMBIGUOUS';
  }
  assert.equal(verifyGoalOutcomeTruth(task).ok, false);
});

test('C07 a newer failed UIA verification cannot reuse a previously successful observation', () => {
  const task = fixture();
  task.execution!.records.push(mutation('operate-app-target', 200, 'SUCCEEDED', true));
  const snapshot = { uiaElements: [{ automationIdHash: digest('editor'), valueHash: digest('ready') }] };
  task.execution!.records.push(observation('verify-app-target', 300, 400, snapshot));
  assert.equal(verifyGoalOutcomeTruth(task).ok, true);
  task.execution!.records.push(mutation('verify-app-target', 500, 'FAILED'));
  assert.equal(verifyGoalOutcomeTruth(task).ok, false);
});

test('C07 a later failed goal attempt supersedes earlier physical fallback proof', () => {
  const task = fixture();
  const physical = mutation('operate-app-physical-fallback', 200, 'SUCCEEDED', true);
  if (physical.observation?.schemaVersion === 2) {
    physical.observation.importantState = { postcondition: {
      dispatched: true, captureLeaseConsumed: true, afterCaptured: true,
      afterSha256: 'c'.repeat(64)
    } };
  }
  task.execution!.records.push(physical);
  assert.equal(verifyGoalOutcomeTruth(task).ok, true);
  task.execution!.records.push(mutation('verify-app-target', 300, 'FAILED'));
  assert.equal(verifyGoalOutcomeTruth(task).ok, false);
});
