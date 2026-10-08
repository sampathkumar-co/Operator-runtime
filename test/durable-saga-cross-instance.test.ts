import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableSagaKernel } from '../src/core/durable-saga.ts';

test('independent saga state stores retain concurrent submissions and reject changed saga contracts', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-saga-state-cross-'));
  t.after(() => fs.rm(state, {recursive: true, force: true}));
  const stores = Array.from({length: 8}, () => new DurableSagaKernel(state, {
    kernel: {} as any, permissions: {allowedCapabilities: ['file.read'], allowedRoots: []}
  }));
  const step = (id: string, input: number) => ({
    key: 'inspect',
    action: {id: 'action-' + id, capability: 'file.read', risk: 'read' as const,
      input: {value: input}, provenance: {kind: 'trusted_policy' as const}}
  });
  const ids = Array.from({length: 20}, () => crypto.randomUUID());
  const created = await Promise.all(ids.map((id, index) => stores[index % stores.length]!.submit({
    sagaId: id, objective: 'Observe operation ' + index,
    steps: [step(id, index)]
  })));
  assert.equal(created.length, 20);
  assert.equal(new Set(created.map((entry) => entry.id)).size, 20);
  const loaded = await new DurableSagaKernel(state, {
    kernel: {} as any, permissions: {allowedCapabilities: [], allowedRoots: []}
  }).list(100);
  assert.deepEqual(new Set(loaded.map((entry) => entry.id)), new Set(ids));
  const conflictId = crypto.randomUUID();
  const collision = await Promise.allSettled([
    stores[0]!.submit({sagaId: conflictId, objective: 'Unique immutable saga', steps: [step(conflictId, 1)]}),
    stores[1]!.submit({sagaId: conflictId, objective: 'Different immutable saga', steps: [step(conflictId, 2)]})
  ]);
  assert.equal(collision.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(collision.find((x): x is PromiseRejectedResult => x.status === 'rejected')?.reason?.code, 'SAGA_ID_CONFLICT');
  assert.equal((await stores[7]!.list(100)).length, 21);
  const winner = collision.find((x): x is PromiseFulfilledResult<any> => x.status === 'fulfilled')!.value;
  const retry = await stores[3]!.submit({
    sagaId: winner.id, objective: winner.objective,
    steps: [step(winner.id, winner.objective === 'Unique immutable saga' ? 1 : 2)]
  });
  assert.equal(retry.contractDigest, winner.contractDigest);
});
