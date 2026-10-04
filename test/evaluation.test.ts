import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EvaluationStore, evaluationRunFromTask } from '../src/core/evaluation.ts';
import { createTask } from '../src/core/task.ts';

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-eval-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

test('stage18 distinguishes claimed success from independently verified success', async (t) => {
  const store = new EvaluationStore(await temp(t));
  await store.registerScenario({
    id: 'desktop.export',
    version: 1,
    category: 'desktop',
    title: 'Export a project',
    contractDigest: digest('contract'),
    requiredCapabilities: ['app.operate'],
    chaosTags: ['ui-shift']
  });
  const now = new Date().toISOString();
  await store.recordRun({
    id: crypto.randomUUID(),
    scenarioId: 'desktop.export',
    scenarioVersion: 1,
    runtimeVersion: '3.0.0',
    sourceCommit: 'a'.repeat(40),
    startedAt: now,
    finishedAt: now,
    claimedSuccess: true,
    verifiedSuccess: false,
    recoveredFailure: false,
    humanInterventions: 1,
    actionCount: 10,
    modelCalls: 3,
    tokenCount: 1000,
    latencyMs: 5000,
    costMicros: 20000,
    fallbackCount: 2,
    uncertainMutationCount: 1,
    evidenceDigest: digest('run')
  });
  const summary = await store.summary({ runtimeVersion: '3.0.0' });
  assert.equal(summary.claimedSuccesses, 1);
  assert.equal(summary.verifiedSuccesses, 0);
  assert.equal(summary.falseSuccesses, 1);
  assert.equal(summary.falseSuccessRate, 1);
});

test('stage18 regression comparison flags reliability improvements and regressions', async (t) => {
  const store = new EvaluationStore(await temp(t));
  await store.registerScenario({
    id: 'recovery.network',
    version: 1,
    category: 'recovery',
    title: 'Recover after network loss',
    contractDigest: digest('recovery'),
    requiredCapabilities: [],
    chaosTags: ['network-drop']
  });
  for (const [version, commit, verified, latency] of [
    ['1.0.0', 'a'.repeat(40), false, 6000],
    ['2.0.0', 'b'.repeat(40), true, 3000]
  ] as const) {
    const now = new Date().toISOString();
    await store.recordRun({
      id: crypto.randomUUID(), scenarioId: 'recovery.network', scenarioVersion: 1,
      runtimeVersion: version, sourceCommit: commit, startedAt: now, finishedAt: now,
      claimedSuccess: verified, verifiedSuccess: verified, recoveredFailure: verified,
      humanInterventions: 0, actionCount: 5, modelCalls: 1, tokenCount: 100,
      latencyMs: latency, costMicros: 1000, fallbackCount: 0, uncertainMutationCount: 0,
      evidenceDigest: digest(version)
    });
  }
  const comparison = await store.compare({
    baseline: { runtimeVersion: '1.0.0' },
    candidate: { runtimeVersion: '2.0.0' }
  });
  assert.ok(comparison.improved.includes('verifiedSuccessRate'));
  assert.ok(comparison.improved.includes('averageLatencyMs'));
  assert.equal(comparison.regressed.length, 0);
});

test('stage18 run IDs are retry-idempotent but conflict-safe', async (t) => {
  const store = new EvaluationStore(await temp(t));
  await store.registerScenario({
    id: 'security.prompt',
    version: 1,
    category: 'security',
    title: 'Ignore prompt injection',
    contractDigest: digest('security'),
    requiredCapabilities: [],
    chaosTags: ['prompt-injection']
  });
  const now = new Date().toISOString();
  const run = {
    id: crypto.randomUUID(), scenarioId: 'security.prompt', scenarioVersion: 1,
    runtimeVersion: '1.0.0', sourceCommit: 'c'.repeat(40), startedAt: now, finishedAt: now,
    claimedSuccess: true, verifiedSuccess: true, recoveredFailure: false,
    humanInterventions: 0, actionCount: 1, modelCalls: 1, tokenCount: 10,
    latencyMs: 10, costMicros: 10, fallbackCount: 0, uncertainMutationCount: 0,
    evidenceDigest: digest('security-run')
  };
  await store.recordRun(run);
  await store.recordRun(run);
  await assert.rejects(
    () => store.recordRun({ ...run, verifiedSuccess: false }),
    (error: any) => error?.code === 'EVALUATION_RUN_CONFLICT'
  );
});

test('runtime-native evaluation derives action, planner, retry, reconciliation, verification and failure telemetry from durable Task truth', () => {
  const task = createTask({
    userObjective: 'evaluate', interpretedObjective: 'evaluate', authorizedScope: ['browser:https://example.test'],
    prohibitedScope: [], successConditions: ['verified']
  });
  task.state = 'FAILED';
  task.execution = {
    schemaVersion: 1, plannerId: 'operator.autonomous-workflow.v1', goalKind: 'autonomous-workflow', plannerState: {},
    maxSteps: 10, maxAttemptsPerStep: 2, timeoutMs: 60_000, stepCount: 2,
    plannerIterations: 4, preDispatchReobserves: 1, dispatchedActions: 2,
    startedAt: '2026-10-04T00:00:00.000Z', records: [{
      stepKey: 'one', actionId: 'action-one', capability: 'browser.interact', risk: 'external',
      inputHash: digest('input'), attempt: 2, state: 'FAILED', startedAt: '2026-10-04T00:00:01.000Z',
      finishedAt: '2026-10-04T00:00:02.000Z', errorCode: 'BROWSER_NO_PROGRESS',
      sideEffectState: 'uncertain', executionPhase: 'reconciled', evidence: []
    }], plannerEvents: [{
      kind: 'RECONCILIATION_REQUIRED', decision: 'RECONCILE', code: 'ACTION_RECONCILIATION_REQUIRED',
      at: '2026-10-04T00:00:02.000Z', provider: 'browser.cdp', capability: 'browser.interact'
    }]
  };
  task.failures.push({ at: '2026-10-04T00:00:03.000Z', code: 'TASK_PLANNER_FAILED', message: 'planner failed' });
  task.evidence.push({ kind: 'independent_task_verification', status: 'pass', message: 'checked', timestamp: '2026-10-04T00:00:02.500Z' });
  task.updatedAt = '2026-10-04T00:00:03.000Z';
  const run = evaluationRunFromTask({
    id: crypto.randomUUID(), scenarioId: 'browser.general', scenarioVersion: 1,
    runtimeVersion: '4.0.0', sourceCommit: 'd'.repeat(40), candidateDirty: false,
    runnerHash: digest('runner'), task, seed: 7, model: 'model-x', provider: 'provider-y',
    modelConfigDigest: digest('config'), environmentDigest: digest('runtime-image-and-host'),
    inputTokens: 100, cachedInputTokens: 40, outputTokens: 20,
    plannerCalls: 3, modelLatencyMs: 500, runtimeLatencyMs: 1200
  });
  assert.equal(run.actionCount, 2);
  assert.equal(run.plannerIterations, 4);
  assert.equal(run.reobserves, 1);
  assert.equal(run.providerRetries, 1);
  assert.equal(run.reconciliationCount, 1);
  assert.equal(run.verificationCount, 1);
  assert.equal(run.uncertainMutationCount, 1);
  assert.equal(run.plannerFailures, 1);
  assert.equal(run.runtimeFailures, 1);
  assert.equal(run.taskFailures, 1);
  assert.equal(run.observationCount, 0);
  assert.equal(run.visualCaptureCount, 0);
  assert.equal(run.retryCount, 1);
  assert.equal(run.duplicateActions, 0);
  assert.equal(run.successfulSubgoals, 0);
  assert.equal(run.tokenCount, 120);
  assert.equal(run.cachedInputTokens, 40);
  assert.equal(run.environmentDigest, digest('runtime-image-and-host'));
  assert.equal(run.primaryFailure?.code, 'BROWSER_NO_PROGRESS');
  assert.equal(run.primaryFailure?.source, 'provider');
  assert.equal(run.primaryFailure?.executionPhase, 'reconciled');
  assert.equal(run.primaryFailure?.sideEffectState, 'uncertain');
  assert.equal(run.secondaryFailures?.[0]?.code, 'TASK_PLANNER_FAILED');
  assert.equal(run.recoveryAttempts, 3);
  assert.equal(run.replans, 0);
  assert.equal(run.environmentActions, 2);
  assert.equal(run.verificationState, 'pending');
});

test('runtime taxonomy keeps teardown and audit failures secondary to the real root cause', () => {
  const task = createTask({
    userObjective: 'classify', interpretedObjective: 'classify', authorizedScope: [], prohibitedScope: [], successConditions: ['done']
  });
  task.state = 'FAILED';
  task.execution = {
    schemaVersion: 1, plannerId: 'planner', goalKind: 'test', plannerState: {}, maxSteps: 2,
    maxAttemptsPerStep: 1, timeoutMs: 1000, stepCount: 1, startedAt: '2026-10-04T00:00:00.000Z',
    records: [{
      stepKey: 'step', actionId: 'action', capability: 'browser.interact', risk: 'external', inputHash: digest('x'),
      attempt: 1, state: 'FAILED', startedAt: '2026-10-04T00:00:01.000Z', finishedAt: '2026-10-04T00:00:02.000Z',
      errorCode: 'BROWSER_STALE_TARGET', executionPhase: 'pre_dispatch', sideEffectState: 'none', evidence: []
    }]
  };
  task.failures.push({ at: '2026-10-04T00:00:03.000Z', code: 'BROWSER_TEARDOWN_CDP_FAILED', message: 'close failed' });
  task.evidence.push({
    kind: 'audit_persistence', status: 'fail', message: 'audit failed', data: { code: 'AUDIT_APPEND_FAILED' }, timestamp: '2026-10-04T00:00:04.000Z'
  });
  task.updatedAt = '2026-10-04T00:00:04.000Z';
  const run = evaluationRunFromTask({
    id: crypto.randomUUID(), scenarioId: 'taxonomy.root-cause', scenarioVersion: 1, runtimeVersion: '4.0.0',
    sourceCommit: 'e'.repeat(40), candidateDirty: false, runnerHash: digest('runner'), task, seed: 1,
    model: 'model', provider: 'provider', modelConfigDigest: digest('config'), environmentDigest: digest('environment')
  });
  assert.equal(run.primaryFailure?.code, 'BROWSER_STALE_TARGET');
  assert.deepEqual(run.secondaryFailures?.map((cause) => cause.code), ['BROWSER_TEARDOWN_CDP_FAILED', 'AUDIT_APPEND_FAILED']);
});
