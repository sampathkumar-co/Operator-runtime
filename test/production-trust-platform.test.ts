import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createUpdateRollout,
  evaluateProductionPlatformSlo,
  evaluateProductionSlo,
  recordUpdateRollbackResult,
  recordUpdateWaveResult,
  RelayOwnershipFenceStore,
  startUpdateRollout
} from '../src/core/production-trust-platform.ts';

const policy = {
  minVerificationRate: 0.99,
  maxFalseCompletionRate: 0,
  maxUncertainRate: 0.01,
  maxP95CompletionMs: 20_000,
  minCrashFreeSessionRate: 0.999,
  minUpdateSuccessRate: 0.99
};

function healthySlo() {
  return evaluateProductionSlo({
    operation: {
      traces: 100,
      completed: 100,
      blocked: 0,
      failed: 0,
      uncertain: 0,
      verified: 100,
      completionRate: 1,
      verificationRate: 1,
      falseCompletionCount: 0,
      p50CompletionMs: 100,
      p95CompletionMs: 200
    },
    crashFreeSessionRate: 1,
    updateSuccessRate: 1
  }, policy);
}

test('production SLO explicitly fails false completion and uncertainty', () => {
  const decision = evaluateProductionSlo({
    operation: {
      traces: 100, completed: 99, blocked: 0, failed: 1, uncertain: 2, verified: 97,
      completionRate: .99, verificationRate: .97, falseCompletionCount: 1,
      p50CompletionMs: 100, p95CompletionMs: 250
    },
    crashFreeSessionRate: 1,
    updateSuccessRate: 1
  }, policy);
  assert.equal(decision.healthy, false);
  assert.ok(decision.reasons.includes('VERIFICATION_RATE_LOW'));
  assert.ok(decision.reasons.includes('FALSE_COMPLETION_RATE_HIGH'));
  assert.ok(decision.reasons.includes('UNCERTAIN_RATE_HIGH'));
});

test('relay ownership fence prevents split-brain and rotates generation after expiry', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-fence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = new Date('2026-10-07T00:00:00.000Z');
  const store = new RelayOwnershipFenceStore(root, { clock: () => now });
  const first = await store.acquire({ resourceKey: 'device:abc', ownerInstanceId: 'relay:a', leaseMs: 5000 });
  await assert.rejects(() => store.acquire({ resourceKey: 'device:abc', ownerInstanceId: 'relay:b', leaseMs: 5000 }), /another live instance/);
  await store.assertCurrent({ resourceKey:first.resourceKey, ownerInstanceId:first.ownerInstanceId, generation:first.generation, token:first.token, now:'2026-10-07T00:00:04.000Z' });
  now = new Date('2026-10-07T00:00:06.000Z');
  const second = await store.acquire({ resourceKey: 'device:abc', ownerInstanceId: 'relay:b', leaseMs: 5000 });
  assert.equal(second.generation, 2);
  assert.notEqual(second.token, first.token);
  await assert.rejects(() => store.assertCurrent({
    resourceKey: first.resourceKey,
    ownerInstanceId: first.ownerInstanceId,
    generation: first.generation,
    token: first.token,
    now: '2026-10-07T00:00:06.000Z'
  }), /stale|no longer active/i);
});

test('staged update rollout completes healthy waves and demands rollback on health regression', () => {
  let rollout = createUpdateRollout({
    version: '2.1.0',
    channel: 'canary',
    waves: [
      { id:'canary', targetCount:10, minHealthyCount:10 },
      { id:'broad', targetCount:90, minHealthyCount:89 }
    ],
    now: '2026-10-07T00:00:00.000Z'
  });
  rollout = startUpdateRollout(rollout, '2026-10-07T00:01:00.000Z');
  rollout = recordUpdateWaveResult({
    state: rollout,
    completedTargets: 10,
    healthyTargets: 10,
    rollbackAvailable: true,
    slo: healthySlo(),
    now: '2026-10-07T00:02:00.000Z'
  });
  assert.equal(rollout.state, 'RUNNING');
  assert.equal(rollout.currentWave, 1);

  const bad = { ...healthySlo(), healthy:false, reasons:['CRASH_FREE_SESSION_RATE_LOW'] };
  rollout = recordUpdateWaveResult({
    state: rollout,
    completedTargets: 20,
    healthyTargets: 18,
    rollbackAvailable: true,
    slo: bad,
    now: '2026-10-07T00:03:00.000Z'
  });
  assert.equal(rollout.state, 'ROLLING_BACK');
  assert.ok(rollout.rollbackStartedAt);
  assert.match(rollout.reason ?? '', /CRASH_FREE_SESSION_RATE_LOW/);

  rollout = recordUpdateRollbackResult({
    state: rollout,
    healthyTargets: 20,
    failedTargets: 0,
    slo: healthySlo(),
    now: '2026-10-07T00:04:00.000Z'
  });
  assert.equal(rollout.state, 'ROLLED_BACK');
  assert.equal(rollout.rollbackFailedTargets, 0);
  assert.equal(rollout.reason, 'AUTOMATIC_ROLLBACK_COMPLETED');
});


test('platform SLO fails closed on infrastructure recovery and retention regressions', () => {
  const platformPolicy = {
    ...policy,
    minControlPlaneAvailability: 0.999,
    minReconnectSuccessRate: 0.995,
    maxP95DispatchMs: 1_000,
    maxP95VerificationMs: 5_000,
    maxQueueDepth: 1_000,
    maxP95DeliveryAgeMs: 10_000,
    maxP95ReconciliationMs: 30_000,
    maxStateBytes: 1024 * 1024 * 1024,
    maxRetentionViolationCount: 0
  };
  const decision = evaluateProductionPlatformSlo({
    operation: {
      traces: 100, completed: 100, blocked: 0, failed: 0, uncertain: 0, verified: 100,
      completionRate: 1, verificationRate: 1, falseCompletionCount: 0,
      p50CompletionMs: 100, p95CompletionMs: 200
    },
    crashFreeSessionRate: 1,
    updateSuccessRate: 1,
    controlPlaneAvailability: 0.98,
    reconnectSuccessRate: 0.90,
    p95DispatchMs: 1_500,
    p95VerificationMs: 6_000,
    queueDepth: 1_500,
    p95DeliveryAgeMs: 12_000,
    p95ReconciliationMs: 45_000,
    stateBytes: 2 * 1024 * 1024 * 1024,
    retentionViolationCount: 2
  }, platformPolicy);
  assert.equal(decision.healthy, false);
  for (const reason of [
    'CONTROL_PLANE_AVAILABILITY_LOW',
    'RECONNECT_SUCCESS_RATE_LOW',
    'P95_DISPATCH_LATENCY_HIGH',
    'P95_VERIFICATION_LATENCY_HIGH',
    'QUEUE_DEPTH_HIGH',
    'P95_DELIVERY_AGE_HIGH',
    'P95_RECONCILIATION_LATENCY_HIGH',
    'STATE_GROWTH_HIGH',
    'RETENTION_COMPLIANCE_FAILED'
  ]) assert.ok(decision.reasons.includes(reason), reason);
});

test('platform SLO accepts healthy operational recovery objectives', () => {
  const decision = evaluateProductionPlatformSlo({
    operation: {
      traces: 100, completed: 100, blocked: 0, failed: 0, uncertain: 0, verified: 100,
      completionRate: 1, verificationRate: 1, falseCompletionCount: 0,
      p50CompletionMs: 100, p95CompletionMs: 200
    },
    crashFreeSessionRate: 1,
    updateSuccessRate: 1,
    controlPlaneAvailability: 1,
    reconnectSuccessRate: 1,
    p95DispatchMs: 100,
    p95VerificationMs: 500,
    queueDepth: 10,
    p95DeliveryAgeMs: 200,
    p95ReconciliationMs: 1_000,
    stateBytes: 1024 * 1024,
    retentionViolationCount: 0
  }, {
    ...policy,
    minControlPlaneAvailability: 0.999,
    minReconnectSuccessRate: 0.995,
    maxP95DispatchMs: 1_000,
    maxP95VerificationMs: 5_000,
    maxQueueDepth: 1_000,
    maxP95DeliveryAgeMs: 10_000,
    maxP95ReconciliationMs: 30_000,
    maxStateBytes: 1024 * 1024 * 1024,
    maxRetentionViolationCount: 0
  });
  assert.equal(decision.healthy, true);
  assert.deepEqual(decision.reasons, []);
});


test('automatic rollback halts when rollback targets or health fail', () => {
  let rollout = startUpdateRollout(createUpdateRollout({
    version:'2.2.0',
    channel:'canary',
    waves:[{id:'canary',targetCount:2,minHealthyCount:2}],
    now:'2026-10-07T01:00:00.000Z'
  }),'2026-10-07T01:00:01.000Z');
  rollout = recordUpdateWaveResult({
    state:rollout,
    completedTargets:2,
    healthyTargets:1,
    rollbackAvailable:true,
    slo:{...healthySlo(),healthy:false,reasons:['P95_DISPATCH_LATENCY_HIGH']},
    now:'2026-10-07T01:00:02.000Z'
  });
  assert.equal(rollout.state,'ROLLING_BACK');
  rollout = recordUpdateRollbackResult({
    state:rollout,
    healthyTargets:1,
    failedTargets:1,
    slo:healthySlo(),
    now:'2026-10-07T01:00:03.000Z'
  });
  assert.equal(rollout.state,'HALTED');
  assert.equal(rollout.reason,'AUTOMATIC_ROLLBACK_TARGET_FAILED');
});

test('rollout rehydration rejects incoherent channel, accounting, and time state', () => {
  const ready = createUpdateRollout({
    version:'2.3.0',
    channel:'canary',
    waves:[{id:'canary',targetCount:2,minHealthyCount:2}],
    now:'2026-10-07T02:00:00.000Z'
  });
  assert.throws(
    () => startUpdateRollout({ ...ready, channel:'internal' as any }, '2026-10-07T02:00:01.000Z'),
    /channel/i
  );

  const running = startUpdateRollout(ready, '2026-10-07T02:00:01.000Z');
  assert.throws(
    () => recordUpdateWaveResult({
      state:{ ...running, completedTargets:1, healthyTargets:1, failedTargets:1 },
      completedTargets:2, healthyTargets:2, rollbackAvailable:true, slo:healthySlo(),
      now:'2026-10-07T02:00:02.000Z'
    }),
    /accounting/i
  );
  assert.throws(
    () => recordUpdateWaveResult({
      state:{ ...running, updatedAt:'2026-10-07T01:59:59.000Z' },
      completedTargets:2, healthyTargets:2, rollbackAvailable:true, slo:healthySlo(),
      now:'2026-10-07T02:00:02.000Z'
    }),
    /predates/i
  );
});

test('relay fence durable reload rejects impossible timestamp order', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-fence-corrupt-time-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = new Date('2026-10-07T03:00:00.000Z');
  const store = new RelayOwnershipFenceStore(root, { clock: () => now });
  const fence = await store.acquire({ resourceKey:'device:time', ownerInstanceId:'relay:a', leaseMs:5000 });
  const stateFile = path.join(root, 'relay-cluster-fences.json');
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  state.fences[0].renewedAt = '2026-10-07T03:00:06.000Z';
  state.fences[0].expiresAt = '2026-10-07T03:00:05.000Z';
  await fs.writeFile(stateFile, JSON.stringify(state));
  await assert.rejects(
    () => new RelayOwnershipFenceStore(root, { clock: () => now }).assertCurrent({
      resourceKey:fence.resourceKey, ownerInstanceId:fence.ownerInstanceId,
      generation:fence.generation, token:fence.token, now:'2026-10-07T03:00:01.000Z'
    }),
    /timestamps are inconsistent/i
  );
});
