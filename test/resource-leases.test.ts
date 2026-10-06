import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ResourceLeaseStore } from '../src/core/resource-leases.ts';
import { CAPABILITY_RISK_RULES } from '../src/core/capability-policy.ts';
import { RESOURCE_EXTRACTOR_CAPABILITIES, resolvePhysicalResourceKeysForAction, resourceKeysConflict, resourceKeysForAction, validateResourceExtractorCoverage } from '../src/core/resource-identity.ts';
import { ActionTransitionJournal } from '../src/core/action-transition-journal.ts';

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
  assert.deepEqual(browserKeys, ['browser:instance:default/targets/abc']);
});

test('untargeted browser identity covers every target in only its browser instance', () => {
  const action = (id: string, input: Record<string, unknown>) => resourceKeysForAction({
    id,
    capability: 'browser.navigate',
    risk: 'write',
    input: { url: 'https://example.test/', ...input },
    provenance: { kind: 'runtime' }
  })[0]!;
  const anyDefault = action('any-default', {});
  const tabOne = action('tab-one', { targetId: 'tab-1' });
  const tabOneAgain = action('tab-one-again', { targetId: 'TAB-1' });
  const tabTwo = action('tab-two', { targetId: 'tab-2' });
  const anySeparate = action('any-separate', { sessionId: 'browser-b' });
  const separateTab = action('separate-tab', { sessionId: 'browser-b', targetId: 'tab-1' });

  assert.equal(anyDefault, 'browser:instance:default/targets');
  assert.equal(resourceKeysConflict(anyDefault, tabOne), true);
  assert.equal(resourceKeysConflict(tabOne, tabOneAgain), true);
  assert.equal(resourceKeysConflict(tabOne, tabTwo), false);
  assert.equal(resourceKeysConflict(anyDefault, separateTab), false);
  assert.equal(resourceKeysConflict(anySeparate, separateTab), true);
});

test('untargeted browser lease remains authoritative until target resolution', async (t) => {
  const store = new ResourceLeaseStore(await temp(t));
  const anyTarget = resourceKeysForAction({
    id: 'select-target', capability: 'browser.navigate', risk: 'write',
    input: { url: 'https://example.test/' }, provenance: { kind: 'runtime' }
  });
  const tabOne = resourceKeysForAction({
    id: 'tab-one', capability: 'browser.interact', risk: 'external',
    input: { targetId: 'tab-1' }, provenance: { kind: 'runtime' }
  });
  const tabTwo = resourceKeysForAction({
    id: 'tab-two', capability: 'browser.interact', risk: 'external',
    input: { targetId: 'tab-2' }, provenance: { kind: 'runtime' }
  });

  const unresolved = await store.acquire('selector', anyTarget, 'exclusive');
  await assert.rejects(() => store.acquire('tab-one', tabOne, 'exclusive'), (error: any) => error?.code === 'RESOURCE_BUSY');
  await unresolved.release();

  const resolvedOne = await store.acquire('tab-one', tabOne, 'exclusive');
  const resolvedTwo = await store.acquire('tab-two', tabTwo, 'exclusive');
  await resolvedTwo.release();
  await resolvedOne.release();
});

test('untargeted browser quarantine blocks concrete targets and accepts same-action reconciliation', async (t) => {
  const store = new ResourceLeaseStore(await temp(t));
  const anyTarget = 'browser:instance:default/targets';
  const concreteTarget = 'browser:instance:default/targets/tab-1';
  await store.quarantine('uncertain-browser-action', [anyTarget]);

  await assert.rejects(
    () => store.acquire('different-action', [concreteTarget], 'exclusive', { mutationActionId: 'different-action' }),
    (error: any) => error?.code === 'RESOURCE_QUARANTINED' && error?.details?.actionId === 'uncertain-browser-action'
  );
  const reconciler = await store.acquire('reconciler', [concreteTarget], 'exclusive', { mutationActionId: 'uncertain-browser-action' });
  await reconciler.release();

  const otherInstance = await store.acquire('other-browser', ['browser:instance:browser-b/targets/tab-1'], 'exclusive', { mutationActionId: 'other-action' });
  await otherInstance.release();
});

test('legacy browser global quarantine conflicts with new concrete target identity after upgrade', async (t) => {
  const store = new ResourceLeaseStore(await temp(t));
  await store.quarantine('legacy-uncertain', ['browser:session:default/target:global']);
  await assert.rejects(
    () => store.acquire('new-action', ['browser:instance:default/targets/tab-1'], 'exclusive', { mutationActionId: 'new-action' }),
    (error: any) => error?.code === 'RESOURCE_QUARANTINED' && error?.details?.actionId === 'legacy-uncertain'
  );
});

test('legacy browser journal identity remains retry-compatible with canonical target hierarchy', async (t) => {
  const state = await temp(t);
  const action = {
    id: 'browser-upgrade-retry', capability: 'browser.navigate', risk: 'write' as const,
    input: { url: 'https://example.test/' }, provenance: { kind: 'runtime' as const }
  };
  const journal = new ActionTransitionJournal(state);
  await journal.prepare({ action, ownerKind: 'test', ownerId: action.id, resourceKeys: ['browser:session:default/target:global'] });
  const retried = await journal.prepare({ action, ownerKind: 'test', ownerId: action.id, resourceKeys: resourceKeysForAction(action) });
  assert.equal(retried.actionId, action.id);
  assert.deepEqual(retried.resourceKeys, ['browser:session:default/target:global']);
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


test('durable resource quarantine blocks conflicting mutations but permits reads and owning-action reconciliation', async (t) => {
  const state = await temp(t);
  const store = new ResourceLeaseStore(state);
  const parent = 'fs-path:C:/project';
  const child = 'fs-path:C:/project/data/file.txt';
  await store.quarantine('action-a', [parent]);

  await assert.rejects(
    () => store.acquire('writer-b', [child], 'exclusive', { mutationActionId: 'action-b' }),
    (error: any) => error?.code === 'RESOURCE_QUARANTINED' && error?.details?.actionId === 'action-a'
  );

  const reader = await store.acquire('reader', [child], 'shared');
  await reader.release();

  const reconciler = await store.acquire('reconcile-a', [child], 'exclusive', { mutationActionId: 'action-a' });
  await reconciler.release();

  assert.equal((await store.inspect()).quarantines.length, 1);
  await store.clearQuarantine('action-a');
  const writer = await store.acquire('writer-b', [child], 'exclusive', { mutationActionId: 'action-b' });
  await writer.release();
});

test('resource lease v1 state migrates without inventing quarantines', async (t) => {
  const state = await temp(t);
  await fs.writeFile(path.join(state, 'resource-leases.json'), JSON.stringify({ version: 1, resources: [] }));
  const store = new ResourceLeaseStore(state);
  await store.quarantine('migration-action', ['repo:/tmp/migration']);
  const snapshot = await store.inspect();
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.quarantines[0]?.actionId, 'migration-action');
});
