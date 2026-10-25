import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createTask, type TaskCapsule } from '../src/core/task.ts';
import { verifyGoalOutcomeTruth } from '../src/core/task-verifier.ts';

function trustedCommand(): TaskCapsule {
  return createTask({
    userObjective: 'Run registered lint',
    interpretedObjective: 'Verify registered lint command',
    authorizedScope: ['/authorized'], prohibitedScope: [],
    successConditions: ['The trusted lint command passes validation'],
    execution: {
      schemaVersion: 1, plannerId: 'operator.semantic.v1',
      goalKind: 'trusted-project-command',
      plannerState: {
        phase: 'complete',
        goal: { kind: 'trusted-project-command', root: '/authorized', commandKind: 'lint' }
      },
      maxSteps: 8, maxAttemptsPerStep: 2, timeoutMs: 30_000,
      stepCount: 1, records: [{
        stepKey: 'run-command', actionId: 'trusted-lint-0',
        capability: 'project.command.run', risk: 'read',
        inputHash: crypto.createHash('sha256').update('lint').digest('hex'),
        attempt: 0, state: 'SUCCEEDED',
        startedAt: '2026-10-25T10:00:00.000Z',
        finishedAt: '2026-10-25T10:00:00.300Z',
        evidence: [{
          kind: 'provider_execution', status: 'pass', message: 'fixture',
          timestamp: '2026-10-25T10:00:00.200Z'
        }],
        observation: {
          schemaVersion: 2, channel: 'semantic', domain: 'project',
          provider: 'fixture-project-command', capability: 'project.command.run',
          entityId: 'project:/authorized',
          observedAt: '2026-10-25T10:00:00.200Z',
          stateVersion: 'a'.repeat(64),
          importantState: { commandKind: 'lint', validationPassed: true, exitCode: 0 },
          epistemicStatus: 'KNOWN', epistemicReason: '',
          ambiguous: false, confidence: 1,
          evidenceRefs: ['b'.repeat(64)]
        }
      }]
    }
  });
}

test('C07 trusted command outcome demands exact validated known machine result', () => {
  const task = trustedCommand();
  assert.equal(verifyGoalOutcomeTruth(task).ok, true);

  const tamper: Array<(task: TaskCapsule) => void> = [
    t => { delete (t.execution!.records[0]!.observation as any).importantState.validationPassed; },
    t => { (t.execution!.records[0]!.observation as any).importantState.validationPassed = false; },
    t => { (t.execution!.records[0]!.observation as any).importantState.commandKind = 'build'; },
    t => { (t.execution!.records[0]!.observation as any).importantState.exitCode = '0'; },
    t => { t.execution!.records[0]!.capability = 'git.status'; },
    t => { (t.execution!.records[0]!.observation as any).capability = 'git.status'; },
    t => { (t.execution!.records[0]!.observation as any).epistemicStatus = 'UNAVAILABLE'; },
    t => { (t.execution!.records[0]!.observation as any).ambiguous = true; },
    t => { (t.execution!.records[0]!.observation as any).observedAt = '2026-10-25T10:00:01Z'; },
    t => { t.execution!.records[0]!.finishedAt = undefined; },
    t => { (t.execution!.plannerState.goal as any).commandKind = ['lint']; }
  ];
  for (const mutate of tamper) {
    const sample = trustedCommand();
    mutate(sample);
    const outcome = verifyGoalOutcomeTruth(sample);
    assert.equal(outcome.supported, true);
    assert.equal(outcome.ok, false);
  }
});
