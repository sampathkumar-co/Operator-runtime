import assert from 'node:assert/strict';
import test from 'node:test';
import { runDurableWaitFanout, LEVELS } from '../scripts/c09-durable-wait-fanout.mjs';

test('C09 bounded 1/10/100/1000 fanout retains exact durable delivery identity', async () => {
  const report = await runDurableWaitFanout();
  assert.equal(report.acceptedAsProductionBenchmark, false);
  assert.equal(report.verifiedExternalActions, 0);
  assert.deepEqual(report.rows.map(row => row.concurrentWaiters), LEVELS);
  for (const row of report.rows) {
    assert.equal(row.durableCommits, 1);
    assert.equal(row.independentlyObserved, row.concurrentWaiters);
    assert.ok(row.p50Ms >= 0 && row.p95Ms >= row.p50Ms);
  }
});
test('C09 refuses unbounded, repeated or unsupported fanout workload profiles', async () => {
  for (const levels of [[], [0], [2], [1, 1], [1001], [1, 10, 100, 1000, 1]]) {
    await assert.rejects(runDurableWaitFanout({ levels }), /C09_FANOUT_LEVEL_INVALID/);
  }
});
