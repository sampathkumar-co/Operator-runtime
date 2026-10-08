import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableSagaKernel } from '../src/core/durable-saga.ts';

test('independent saga kernels cannot run the same external operation concurrently', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-saga-execution-owner-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  let invokeCount = 0;
  let release!: () => void;
  let started!: () => void;
  const invoked = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const kernel = {
    async execute() {
      invokeCount += 1;
      started();
      await held;
      return {
        ok: false, capability: 'file.write', provider: 'synthetic', evidence: [],
        error: { code: 'ACTION_RECONCILIATION_REQUIRED', sideEffectState: 'uncertain' }
      };
    }
  } as any;
  const make = () => new DurableSagaKernel(state, {
    kernel,
    permissions: { allowedCapabilities: ['file.write'], allowedRoots: [] }
  });
  const first = make();
  const second = make();
  const submitted = await first.submit({
    objective: 'Execute one bounded operation',
    steps: [{
      key: 'external-step',
      action: {
        id: 'external-step-action', capability: 'file.write', risk: 'write',
        input: { target: 'shared resource' },
        provenance: { kind: 'trusted_policy' }
      }
    }]
  });
  const running = first.run(submitted.id);
  await invoked;
  assert.equal(invokeCount, 1);
  try {
    await assert.rejects(second.run(submitted.id),
      (error: any) => error?.code === 'DURABLE_STATE_LOCK_BUSY');
    assert.equal(invokeCount, 1, 'the second kernel must not dispatch while the owner is active');
  } finally {
    release();
  }
  const blocked = await running;
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal((await second.run(submitted.id)).state, 'BLOCKED');
  assert.equal(invokeCount, 1);
});
