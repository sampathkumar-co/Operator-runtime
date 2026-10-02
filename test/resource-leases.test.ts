import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ResourceLeaseStore } from '../src/core/resource-leases.ts';
import { resourceKeysForAction } from '../src/core/resource-identity.ts';

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-resource-lease-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('shared resource leases coexist while exclusive lease conflicts', async (t) => {
  const store = new ResourceLeaseStore(await temp(t));
  const key = 'file:/tmp/project/a.txt';
  const first = await store.acquire('task-a', [key], 'shared');
  const second = await store.acquire('task-b', [key], 'shared');
  await assert.rejects(
    () => store.acquire('task-c', [key], 'exclusive'),
    (error: any) => error?.code === 'RESOURCE_BUSY' && error?.retryable === true
  );
  await first.release();
  await second.release();
  const exclusive = await store.acquire('task-c', [key], 'exclusive');
  await exclusive.assertOwned();
  await exclusive.release();
  assert.equal((await store.inspect()).resources.length, 0);
});

test('exclusive lease blocks both readers and writers owned by other executions', async (t) => {
  const store = new ResourceLeaseStore(await temp(t));
  const key = 'repo:/tmp/project';
  const exclusive = await store.acquire('writer', [key], 'exclusive');
  await assert.rejects(() => store.acquire('reader', [key], 'shared'), (error: any) => error?.code === 'RESOURCE_BUSY');
  await assert.rejects(() => store.acquire('writer-2', [key], 'exclusive'), (error: any) => error?.code === 'RESOURCE_BUSY');
  await exclusive.release();
});

test('resource leases reap a stale holder when its PID identifies a newer process instance', async (t) => {
  const state = await temp(t);
  const key = 'repo:/tmp/reused-pid';
  await fs.writeFile(path.join(state, 'resource-leases.json'), JSON.stringify({
    version: 1,
    resources: [{
      key,
      holders: [{
        leaseId: '11111111-1111-4111-8111-111111111111',
        ownerId: 'stale-owner',
        pid: 43001,
        processInstance: { pid: 43001, started: 'old-instance' },
        mode: 'exclusive',
        acquiredAt: new Date().toISOString()
      }]
    }]
  }));
  const store = new ResourceLeaseStore(state, {
    processInstance: { pid: 43002, started: 'new-owner' },
    inspectProcessInstance: async (pid) => pid === 43001 ? { pid, started: 'reused-instance' } : { pid, started: 'new-owner' }
  });

  const replacement = await store.acquire('replacement', [key], 'exclusive');
  await replacement.assertOwned();
  await replacement.release();
});

test('canonical resource identities are deterministic across scheduler layers', () => {
  const root = path.resolve('/tmp/resource-project');
  const fileKeys = resourceKeysForAction({
    id: 'file',
    capability: 'file.manage',
    risk: 'write',
    input: { operation: 'move', source: path.join(root, 'a.txt'), destination: path.join(root, 'b.txt') },
    provenance: { kind: 'runtime' }
  });
  assert.equal(fileKeys.length, 2);
  assert.deepEqual([...fileKeys].sort(), fileKeys);

  const browserKeys = resourceKeysForAction({
    id: 'browser',
    capability: 'browser.interact',
    risk: 'write',
    input: { targetId: 'ABC' },
    provenance: { kind: 'runtime' }
  });
  assert.deepEqual(browserKeys, ['browser:abc']);
});
