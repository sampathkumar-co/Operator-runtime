import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONCURRENCY_LEVELS,
  PROFILE,
  runRelayResultWaitScaling
} from '../scripts/c09-relay-wait-scaling.mjs';

test('C09 source-matched synthetic wait scaling includes all four requested loads with truthful non-acceptance', async () => {
  const result = await runRelayResultWaitScaling({ waitWindowMs: 110 });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.profile, PROFILE);
  assert.equal(result.acceptedAsProductionBenchmark, false);
  assert.equal(result.verifiedSuccessfulActions, 0);
  assert.deepEqual(result.samples.map(x => x.concurrentWaits), [...CONCURRENCY_LEVELS]);
  for (const sample of result.samples) {
    assert.equal(sample.allCancelled, true);
    assert.ok(sample.durableReads >= 1, 'each profile must actually poll');
    assert.ok(sample.durableReads < 35, '1000 waiters must share bounded store polls');
    assert.ok(sample.elapsedMs >= 0);
  }
});

test('C09 synthetic load rejects unbounded or nonnumeric input before allocating waits', async () => {
  for (const args of [
    { levels: [1001] }, { levels: ['1000'] }, { levels: [[1]] },
    { levels: [] }, { waitWindowMs: '100' }, { waitWindowMs: 10000 }
  ]) {
    await assert.rejects(runRelayResultWaitScaling(args), /outside bounded limits/);
  }
});
