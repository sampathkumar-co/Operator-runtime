import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createTask, type TaskCapsule } from '../src/core/task.ts';
import { verifyGoalOutcomeTruth, verifyTaskCompletion } from '../src/core/task-verifier.ts';

const digest = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

function fixture(risk: 'read' | 'write' = 'read'): TaskCapsule {
  const capability = risk === 'write' ? 'project.transaction.run' : 'project.command.run';
  return createTask({
    userObjective: 'Run the registered lint check',
    interpretedObjective: 'Verify the trusted quality gate',
    authorizedScope: ['/test/project'],
    prohibitedScope: [],
    successConditions: ['Registered lint check passes'],
    execution: {
      schemaVersion: 1, plannerId: 'operator.project-quality-gate.v1',
      goalKind: 'project-quality-gate', plannerState: {
        phase: 'complete', qualityChecks: [{ kind: 'lint', id: 'lint-registered', risk }],
        qualityIndex: 1
      },
      maxSteps: 10, maxAttemptsPerStep: 2, timeoutMs: 30_000,
      stepCount: 1, records: [{
        stepKey: 'quality-run:0:lint', actionId: 'quality-action-0',
        capability, risk, inputHash: digest('quality-input'),
        attempt: 0, state: 'SUCCEEDED',
        startedAt: '2026-10-25T10:00:00.000Z',
        finishedAt: '2026-10-25T10:00:00.300Z',
        evidence: [{ kind: 'provider_execution', status: 'pass',
          message: 'Synthetic successful command', timestamp: '2026-10-25T10:00:00.200Z' }],
        observation: {
          schemaVersion: 2, channel: 'semantic', domain: 'project',
          provider: 'fixture-project-provider', capability,
          entityId: 'project:/test/project',
          observedAt: '2026-10-25T10:00:00.200Z',
          stateVersion: digest('quality-state'),
          importantState: { commandKind: 'lint', exitCode: 0, validationPassed: true },
          epistemicStatus: 'KNOWN', epistemicReason: '',
          ambiguous: false, confidence: 1, evidenceRefs: [digest('quality-receipt')]
        }
      }]
    }
  });
}

function assertion(task: TaskCapsule) {
  const result = verifyGoalOutcomeTruth(task);
  assert.equal(result.supported, true);
  return result.ok;
}

test('C07 genuine bounded quality gate has independent typed machine proof', () => {
  assert.equal(assertion(fixture('read')), true);
  assert.equal(assertion(fixture('write')), true);
});

test('C07 refuses missing artifact validation, wrong compiled check or mismatched provider', () => {
  const wrong = [
    (t: TaskCapsule) => { delete (t.execution!.records[0]!.observation as any).importantState.validationPassed; },
    (t: TaskCapsule) => { (t.execution!.records[0]!.observation as any).importantState.validationPassed = false; },
    (t: TaskCapsule) => { (t.execution!.records[0]!.observation as any).importantState.commandKind = 'build'; },
    (t: TaskCapsule) => { t.execution!.records[0]!.capability = 'git.status'; },
    (t: TaskCapsule) => { (t.execution!.plannerState.qualityChecks as any[])[0].kind = 'build'; },
    (t: TaskCapsule) => { (t.execution!.plannerState.qualityChecks as any[])[0].risk = 'external'; },
    (t: TaskCapsule) => { (t.execution!.records[0]!.observation as any).capability = 'file.read'; },
    (t: TaskCapsule) => { (t.execution!.records[0]!.observation as any).epistemicStatus = 'UNKNOWN'; },
    (t: TaskCapsule) => { (t.execution!.records[0]!.observation as any).ambiguous = true; },
    (t: TaskCapsule) => { (t.execution!.records[0]!.observation as any).observedAt = '2026-10-25T09:59:59Z'; },
    (t: TaskCapsule) => { (t.execution!.records[0]!.observation as any).observedAt = '2026-10-25T10:00:01Z'; },
    (t: TaskCapsule) => { t.execution!.records[0]!.finishedAt = undefined; }
  ];
  for (const corrupt of wrong) {
    const task = fixture();
    corrupt(task);
    assert.equal(assertion(task), false);
  }
});

test('C07 a later failed verification attempt cannot resurrect an earlier quality receipt', () => {
  const task = fixture();
  task.execution!.records.push({
    ...task.execution!.records[0]!, actionId: 'quality-action-1',
    attempt: 1, state: 'FAILED', observation: undefined,
    errorCode: 'COMMAND_EXIT_NONZERO'
  });
  assert.equal(assertion(task), false);
  assert.equal(verifyTaskCompletion(task).ok, false);
});
