import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ResourceLeaseStore } from '../src/core/resource-leases.ts';
import { CAPABILITY_RISK_RULES } from '../src/core/capability-policy.ts';
import { RESOURCE_EXTRACTOR_CAPABILITIES, resolvePhysicalResourceKeysForAction, resourceKeysConflict, resourceKeysForAction, validateResourceExtractorCoverage } from '../src/core/resource-identity.ts';

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

test('lease ownership loss is detected before dispatch instead of becoming an uncoordinated mutation', async (t) => {
  const state = await temp(t);
  const store = new ResourceLeaseStore(state);
  const lease = await store.acquire('owner', ['repo:/tmp/lease-loss'], 'exclusive');
  await fs.writeFile(path.join(state, 'resource-leases.json'), JSON.stringify({ version: 1, resources: [] }));
  await assert.rejects(() => lease.assertOwned(), (error: any) => error?.code === 'RESOURCE_LEASE_LOST');
});

test('resource leases preserve a holder when process liveness is unknown', async (t) => {
  const state = await temp(t);
  const key = 'repo:/tmp/inspection-unknown';
  await fs.writeFile(path.join(state, 'resource-leases.json'), JSON.stringify({
    version: 1,
    resources: [{
      key,
      holders: [{
        leaseId: '22222222-2222-4222-8222-222222222222',
        ownerId: 'live-but-uninspectable',
        pid: 44001,
        processInstance: { pid: 44001, started: 'known-instance' },
        mode: 'exclusive',
        acquiredAt: new Date().toISOString()
      }]
    }]
  }));

  const store = new ResourceLeaseStore(state, {
    processInstance: { pid: 44002, started: 'new-owner' },
    observeProcessInstance: async (pid) => pid === 44001
      ? { status: 'unknown' }
      : { status: 'live', identity: { pid, started: 'new-owner' } }
  });

  await assert.rejects(
    () => store.acquire('replacement', [key], 'exclusive'),
    (error: any) => error?.code === 'RESOURCE_BUSY'
  );
  const inspected = await store.inspect();
  assert.equal(inspected.resources[0]?.holders[0]?.ownerId, 'live-but-uninspectable');
});

test('resource leases reap a holder only after confirmed process death', async (t) => {
  const state = await temp(t);
  const key = 'repo:/tmp/confirmed-dead';
  await fs.writeFile(path.join(state, 'resource-leases.json'), JSON.stringify({
    version: 1,
    resources: [{
      key,
      holders: [{
        leaseId: '33333333-3333-4333-8333-333333333333',
        ownerId: 'dead-owner',
        pid: 45001,
        processInstance: { pid: 45001, started: 'dead-instance' },
        mode: 'exclusive',
        acquiredAt: new Date().toISOString()
      }]
    }]
  }));

  const store = new ResourceLeaseStore(state, {
    processInstance: { pid: 45002, started: 'new-owner' },
    observeProcessInstance: async (pid) => pid === 45001
      ? { status: 'dead' }
      : { status: 'live', identity: { pid, started: 'new-owner' } }
  });

  const replacement = await store.acquire('replacement', [key], 'exclusive');
  await replacement.assertOwned();
  await replacement.release();
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
  assert.deepEqual(browserKeys, ['browser:session:default/target:abc']);
});

test('canonical resource extractor registry covers every policy capability and mutations never fall back to cap-global keys', () => {
  validateResourceExtractorCoverage();
  assert.deepEqual([...RESOURCE_EXTRACTOR_CAPABILITIES].sort(), Object.keys(CAPABILITY_RISK_RULES).sort());
  const root = path.resolve(os.tmpdir(), 'operator-resource-coverage');
  const inputFor = (capability: string): Record<string, unknown> => {
    if (capability.startsWith('project.')) return { path: root, cwd: root };
    if (capability === 'file.manage') return { operation: 'move', source: path.join(root, 'a'), destination: path.join(root, 'b') };
    if (capability.startsWith('file.')) return { path: path.join(root, 'a') };
    if (capability.startsWith('git.')) return { cwd: root };
    if (capability.startsWith('docker.')) return { path: root };
    if (capability.startsWith('postgres.')) return { path: root, profileId: 'main' };
    if (capability === 'vscode.open') return { path: path.join(root, 'a') };
    if (capability === 'terminal.execute') return { cwd: root };
    if (capability === 'terminal.session') return { operation: 'start', cwd: root };
    if (capability.startsWith('process.')) return { pid: 4242 };
    if (capability.startsWith('browser.')) return { sessionId: 'session-a', targetId: 'tab-a' };
    return {};
  };

  for (const [capability, rule] of Object.entries(CAPABILITY_RISK_RULES)) {
    if (rule === 'read') continue;
    const keys = resourceKeysForAction({
      id: `coverage-${capability}`,
      capability,
      risk: 'write',
      input: inputFor(capability),
      provenance: { kind: 'runtime' }
    });
    assert.ok(keys.length > 0, capability);
    assert.equal(keys.some((key) => key.startsWith('cap:')), false, capability);
  }
});

test('physical resource identities conflict across repo and child-file capability families', async (t) => {
  const state = await temp(t);
  const root = path.join(state, 'project');
  const child = path.join(root, 'nested', 'value.txt');
  await fs.mkdir(path.dirname(child), { recursive: true });
  await fs.writeFile(child, 'value');

  const repoKeys = await resolvePhysicalResourceKeysForAction({
    id: 'repo-write', capability: 'git.write', risk: 'write',
    input: { cwd: root }, provenance: { kind: 'runtime' }
  });
  const fileKeys = await resolvePhysicalResourceKeysForAction({
    id: 'file-write', capability: 'file.write', risk: 'write',
    input: { path: child }, provenance: { kind: 'runtime' }
  });
  const repoPath = repoKeys.find((key) => key.startsWith('fs-path:'));
  const filePath = fileKeys.find((key) => key.startsWith('fs-path:'));
  assert.ok(repoPath && filePath);
  assert.equal(resourceKeysConflict(repoPath!, filePath!), true);

  const store = new ResourceLeaseStore(state);
  const parent = await store.acquire('repo-owner', repoKeys, 'exclusive');
  await assert.rejects(() => store.acquire('file-owner', fileKeys, 'exclusive'), (error: any) => error?.code === 'RESOURCE_BUSY');
  await parent.release();
});
