import assert from 'node:assert/strict';
import test from 'node:test';
import { DesiredStateReconciler } from '../src/core/desired-state-reconciler.ts';

function contract(id: string, status: string) {
  return { id, status };
}

test('stage20 reconciler skips paused contracts and isolates per-contract failures', async () => {
  const seen: string[] = [];
  const controller = {
    async list() {
      return [
        contract('00000000-0000-4000-8000-000000000001', 'HEALTHY'),
        contract('00000000-0000-4000-8000-000000000002', 'PAUSED'),
        contract('00000000-0000-4000-8000-000000000003', 'DRIFTED')
      ];
    },
    async reconcile(id: string) {
      seen.push(id);
      if (id.endsWith('3')) throw Object.assign(new Error('boom'), { code: 'TEST_RECONCILE_FAILURE' });
      return {};
    }
  };
  const reconciler = new DesiredStateReconciler(controller as any, { intervalMs: 1000, maxPerTick: 10 });
  const result = await reconciler.runOnce();
  assert.deepEqual(seen, [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000003'
  ]);
  assert.equal(result.inspected, 3);
  assert.equal(result.reconciled, 1);
  assert.deepEqual(result.failed, [{
    contractId: '00000000-0000-4000-8000-000000000003',
    code: 'TEST_RECONCILE_FAILURE'
  }]);
});

test('stage20 reconciler never overlaps runOnce executions', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const controller = {
    async list() { return [contract('00000000-0000-4000-8000-000000000004', 'DRIFTED')]; },
    async reconcile() {
      calls += 1;
      await gate;
      return {};
    }
  };
  const reconciler = new DesiredStateReconciler(controller as any, { intervalMs: 1000 });
  const first = reconciler.runOnce();
  const second = reconciler.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
});
