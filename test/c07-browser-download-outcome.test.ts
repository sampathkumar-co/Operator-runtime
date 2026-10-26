import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { canonicalJson } from '../src/core/action-identity.ts';
import { normalizeMachineObservation } from '../src/core/machine-state.ts';
import { createTask, type TaskActionRecord } from '../src/core/task.ts';
import { verifyGoalOutcomeTruth } from '../src/core/task-verifier.ts';

const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const time = (millis: number) => new Date(Date.UTC(2026, 9, 25) + millis).toISOString();
const targetId = 'tab-download';
const target = { role: 'link', name: 'Export report' };
const artifactSha256 = digest('downloaded artifact bytes');
const targetDigest = digest(canonicalJson({ targetId, target }));
const actionInput = { targetId, operation: 'click', target, expectDownload: true, downloadTimeoutMs: 30_000 };

function record(): TaskActionRecord {
  return {
    stepKey: 'download-browser-artifact', actionId: 'download-1', capability: 'browser.interact',
    risk: 'external', inputHash: digest(canonicalJson(actionInput)), attempt: 1, state: 'SUCCEEDED',
    startedAt: time(100), finishedAt: time(400), evidence: [],
    observation: {
      schemaVersion: 2, channel: 'semantic', domain: 'browser', provider: 'synthetic',
      capability: 'browser.interact', entityId: 'browser:download', observedAt: time(300),
      stateVersion: digest('download-state'), importantState: { download: {
        state: 'completed', artifactSha256, artifactBytes: 25,
        initiatingTargetId: targetId, actionTargetDigest: targetDigest,
        completedAt: time(250), suggestedFilenameDigest: digest('report.csv')
      } },
      epistemicStatus: 'KNOWN', epistemicReason: '', ambiguous: false,
      confidence: 1, evidenceRefs: [digest('download-evidence')]
    }
  };
}

function fixture() {
  return createTask({
    userObjective: 'Download the exact report artifact',
    interpretedObjective: 'Click the scoped export target and verify downloaded bytes',
    authorizedScope: ['browser:tab-download'], prohibitedScope: [],
    successConditions: ['downloaded bytes match the expected digest'],
    execution: {
      schemaVersion: 1, plannerId: 'operator.semantic.v1', goalKind: 'browser-download',
      plannerState: { phase: 'complete', goal: {
        kind: 'browser-download', targetId, target, expectedSha256: artifactSha256,
        expectedSuggestedFilename: 'report.csv', timeoutMs: 30_000
      } },
      maxSteps: 2, maxAttemptsPerStep: 2, timeoutMs: 60_000, stepCount: 1,
      records: [record()]
    }
  });
}

test('C07 browser download requires fresh bytes bound to the exact click target', () => {
  const result = verifyGoalOutcomeTruth(fixture());
  assert.equal(result.supported, true);
  assert.equal(result.ok, true);
});

test('C07 browser download rejects artifact, action-input, target, filename, and freshness substitutions', () => {
  const mutations = [
    (item: TaskActionRecord) => { (item.observation!.importantState.download as Record<string, unknown>).artifactSha256 = digest('other bytes'); },
    (item: TaskActionRecord) => { item.inputHash = digest('different action'); },
    (item: TaskActionRecord) => { (item.observation!.importantState.download as Record<string, unknown>).actionTargetDigest = digest('other target'); },
    (item: TaskActionRecord) => { (item.observation!.importantState.download as Record<string, unknown>).suggestedFilenameDigest = digest('other.csv'); },
    (item: TaskActionRecord) => { (item.observation!.importantState.download as Record<string, unknown>).completedAt = time(50); }
  ];
  for (const mutate of mutations) {
    const task = fixture();
    mutate(task.execution!.records[0]!);
    assert.equal(verifyGoalOutcomeTruth(task).ok, false);
  }
});

test('C07 later failed download attempt supersedes earlier valid artifact proof', () => {
  const task = fixture();
  task.execution!.records.push({
    ...record(), actionId: 'download-2', attempt: 2, state: 'FAILED',
    startedAt: time(500), finishedAt: time(600), observation: undefined
  });
  assert.equal(verifyGoalOutcomeTruth(task).ok, false);
});

test('C07 machine evidence admits only a complete bounded hashed download outcome', () => {
  const result = normalizeMachineObservation({
    id: 'download-action', capability: 'browser.interact', input: actionInput,
    risk: 'external', provenance: { kind: 'user', source: 'fixture' }
  }, {
    ok: true, capability: 'browser.interact', provider: 'synthetic', durationMs: 1, evidence: [],
    output: { targetId, operation: 'click', download: {
      state: 'completed', artifactStatus: 'hashed', artifactSha256, artifactBytes: 25,
      initiatingTargetId: targetId, actionTargetDigest: targetDigest,
      completedAt: time(250), suggestedFilename: 'report.csv', filePath: 'C:\\private\\report.csv'
    } }
  });
  assert.deepEqual(result.importantState.download, {
    state: 'completed', artifactSha256, artifactBytes: 25,
    actionTargetDigest: targetDigest, initiatingTargetId: targetId,
    completedAt: time(250), suggestedFilenameDigest: digest('report.csv')
  });
  assert.equal(JSON.stringify(result.importantState).includes('filePath'), false);
});
