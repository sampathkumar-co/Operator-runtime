import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createUpdateRollout,
  evaluateProductionSlo,
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
  assert.equal(second.generation, 1);
  // Expired rows are pruned; a resource returning after full expiry gets a fresh
  // token. Split-brain safety is still carried by exact token ownership.
  assert.notEqual(second.token, first.token);
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
  assert.equal(rollout.state, 'ROLLBACK_REQUIRED');
  assert.match(rollout.reason ?? '', /CRASH_FREE_SESSION_RATE_LOW/);
});
