import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ResourceLeaseStore } from '../src/core/resource-leases.ts';
import { CAPABILITY_RISK_RULES } from '../src/core/capability-policy.ts';
import { RESOURCE_EXTRACTOR_CAPABILITIES, resolvePhysicalResourceKeysForAction, resourceKeysConflict, resourceKeysForAction, validateResourceExtractorCoverage } from '../src/core/resource-identity.ts';
import { ActionTransitionJournal } from '../src/core/action-transition-journal.ts';
import { PolicyEngine } from '../src/core/policy.ts';

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
    if (capability.startsWith('workspace.edit.')) return { workspaceRoot: root };
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

test('terminal declarations bind external mutation paths without parsing argv', async (t) => {
  const state = await temp(t);
  const cwd = path.join(state, 'cwd');
  const external = path.join(state, 'other', 'output.txt');
  await fs.mkdir(path.dirname(external), { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(external, 'before');
  const terminalKeys = await resolvePhysicalResourceKeysForAction({
    id: 'terminal-external', capability: 'terminal.execute', risk: 'destructive',
    input: {
      executable: 'tool', args: ['--output', external], cwd,
      affectedResources: [{ kind: 'path', path: external }]
    },
    provenance: { kind: 'runtime' }
  });
  const fileKeys = await resolvePhysicalResourceKeysForAction({
    id: 'file-external', capability: 'file.replace', risk: 'write',
    input: { path: external, content: 'after' }, provenance: { kind: 'runtime' }
  });

  assert.equal(terminalKeys.some((left) => fileKeys.some((right) => resourceKeysConflict(left, right))), true);
  assert.equal(terminalKeys.includes('filesystem:any'), false);
});

test('same terminal cwd can retain independent declared effect identities', async (t) => {
  const state = await temp(t);
  const cwd = path.join(state, 'cwd');
  const first = path.join(state, 'first.txt');
  const second = path.join(state, 'second.txt');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(first, 'first');
  await fs.writeFile(second, 'second');
  const keys = async (id: string, affectedPath: string) => await resolvePhysicalResourceKeysForAction({
    id, capability: 'terminal.execute', risk: 'destructive',
    input: { executable: 'tool', args: [], cwd, affectedResources: [{ kind: 'path', path: affectedPath }] },
    provenance: { kind: 'runtime' }
  });
  const firstKeys = await keys('terminal-first', first);
  const secondKeys = await keys('terminal-second', second);

  assert.equal(firstKeys.some((left) => secondKeys.some((right) => resourceKeysConflict(left, right))), false);
});

test('undeclared terminal mutation takes a conservative filesystem lease and argv creates no fake authority', async (t) => {
  const state = await temp(t);
  const cwd = path.join(state, 'cwd');
  const argvPath = path.join(state, 'looks-like-a-path.txt');
  await fs.mkdir(cwd, { recursive: true });
  const terminalKeys = await resolvePhysicalResourceKeysForAction({
    id: 'terminal-opaque-argv', capability: 'terminal.execute', risk: 'destructive',
    input: { executable: 'tool', args: ['ordinary-token', argvPath], cwd }, provenance: { kind: 'runtime' }
  });
  const fileKeys = await resolvePhysicalResourceKeysForAction({
    id: 'file-different', capability: 'file.write', risk: 'write',
    input: { path: path.join(state, 'different.txt') }, provenance: { kind: 'runtime' }
  });

  assert.deepEqual(terminalKeys, ['filesystem:any']);
  assert.equal(terminalKeys.some((left) => fileKeys.some((right) => resourceKeysConflict(left, right))), true);
  assert.equal(terminalKeys.some((key) => key.includes('looks-like-a-path')), false);
});

test('terminal resource declarations reject ambiguous or untyped values', () => {
  const base = {
    capability: 'terminal.execute', risk: 'destructive' as const,
    provenance: { kind: 'runtime' as const }
  };
  assert.throws(
    () => resourceKeysForAction({ ...base, id: 'relative', input: { cwd: path.resolve('.'), affectedResources: [{ kind: 'path', path: 'relative.txt' }] } }),
    (error: any) => error?.code === 'RESOURCE_DECLARATION_INVALID'
  );
  assert.throws(
    () => resourceKeysForAction({ ...base, id: 'untyped', input: { cwd: path.resolve('.'), affectedResources: [path.resolve('value.txt')] } }),
    (error: any) => error?.code === 'RESOURCE_DECLARATION_INVALID'
  );
  assert.throws(
    () => resourceKeysForAction({ ...base, id: 'extra-field', input: { cwd: path.resolve('.'), affectedResources: [{ kind: 'path', path: path.resolve('value.txt'), authority: true }] } }),
    (error: any) => error?.code === 'RESOURCE_DECLARATION_INVALID'
  );
});

test('terminal affected path outside authorized roots is denied before dispatch', async (t) => {
  const state = await temp(t);
  const allowed = path.join(state, 'allowed');
  const outside = path.join(state, 'outside', 'output.txt');
  await fs.mkdir(allowed, { recursive: true });
  const action = {
    id: 'terminal-outside-policy', capability: 'terminal.execute', risk: 'destructive' as const,
    input: { executable: 'tool', args: [], cwd: allowed, affectedResources: [{ kind: 'path', path: outside }] },
    provenance: { kind: 'runtime' as const }
  };
  assert.throws(
    () => new PolicyEngine().authorizeBase(action, { allowedCapabilities: ['terminal.execute'], allowedRoots: [allowed] }),
    (error: any) => error?.code === 'PATH_OUTSIDE_SCOPE'
  );
});

test('terminal affected resource quarantine uses the same physical identity', async (t) => {
  const state = await temp(t);
  const cwd = path.join(state, 'cwd');
  const affected = path.join(state, 'external.txt');
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(affected, 'value');
  const terminalKeys = await resolvePhysicalResourceKeysForAction({
    id: 'uncertain-terminal', capability: 'terminal.execute', risk: 'destructive',
    input: { executable: 'tool', args: [], cwd, affectedResources: [{ kind: 'path', path: affected }] },
    provenance: { kind: 'runtime' }
  });
  const fileKeys = await resolvePhysicalResourceKeysForAction({
    id: 'competing-file', capability: 'file.replace', risk: 'write',
    input: { path: affected, content: 'next' }, provenance: { kind: 'runtime' }
  });
  const store = new ResourceLeaseStore(state);
  await store.quarantine('uncertain-terminal', terminalKeys);
  await assert.rejects(
    () => store.acquire('competing-file', fileKeys, 'exclusive', { mutationActionId: 'competing-file' }),
    (error: any) => error?.code === 'RESOURCE_QUARANTINED'
  );
});

test('terminal declarations resolve symbolic paths to the same physical resource', async (t) => {
  const state = await temp(t);
  const cwd = path.join(state, 'cwd');
  const actual = path.join(state, 'actual');
  const linked = path.join(state, 'linked');
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(actual, { recursive: true });
  await fs.writeFile(path.join(actual, 'value.txt'), 'value');
  try {
    await fs.symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('symbolic link creation is unavailable on this runner');
    throw error;
  }
  const terminalKeys = await resolvePhysicalResourceKeysForAction({
    id: 'terminal-linked', capability: 'terminal.execute', risk: 'destructive',
    input: { executable: 'tool', args: [], cwd, affectedResources: [{ kind: 'path', path: path.join(linked, 'value.txt') }] },
    provenance: { kind: 'runtime' }
  });
  const fileKeys = await resolvePhysicalResourceKeysForAction({
    id: 'file-actual', capability: 'file.replace', risk: 'write',
    input: { path: path.join(actual, 'value.txt'), content: 'next' }, provenance: { kind: 'runtime' }
  });
  assert.equal(terminalKeys.some((left) => fileKeys.some((right) => resourceKeysConflict(left, right))), true);
});

test('legacy cwd-only terminal journal upgrades to conservative filesystem authority', async (t) => {
  const state = await temp(t);
  const cwd = path.join(state, 'cwd');
  await fs.mkdir(cwd, { recursive: true });
  const action = {
    id: 'legacy-terminal-retry', capability: 'terminal.execute', risk: 'destructive' as const,
    input: { executable: 'tool', args: [], cwd }, provenance: { kind: 'runtime' as const }
  };
  const journal = new ActionTransitionJournal(state);
  await journal.prepare({ action, ownerKind: 'test', ownerId: action.id, resourceKeys: [`workspace:${cwd.replace(/\\/g, '/').toLowerCase()}`, `fs-path:${cwd.replace(/\\/g, '/').toLowerCase()}`] });
  const retried = await journal.prepare({ action, ownerKind: 'test', ownerId: action.id, resourceKeys: await resolvePhysicalResourceKeysForAction(action) });
  assert.equal(retried.actionId, action.id);
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

test('same owner label never authorizes overlapping exclusive leases from independent instances', async (t) => {
  const state = await temp(t);
  const left = new ResourceLeaseStore(state);
  const right = new ResourceLeaseStore(state);
  const key = 'fs-path:/tmp/same-owner-alias';
  const first = await left.acquire('identical-owner-label', [key], 'exclusive');
  await first.assertOwned();
  await assert.rejects(
    () => right.acquire('identical-owner-label', [key], 'exclusive'),
    (error: any) => error?.code === 'RESOURCE_BUSY'
  );
  await assert.rejects(
    () => right.acquire('identical-owner-label', [key + '/child'], 'shared'),
    (error: any) => error?.code === 'RESOURCE_BUSY'
  );
  await first.assertOwned();
  await first.release();
  const second = await right.acquire('identical-owner-label', [key], 'exclusive');
  assert.notEqual(second.id, first.id);
  await second.assertOwned();
  await second.release();
});

test('same owner label may share read leases but cannot escalate to exclusive', async (t) => {
  const state = await temp(t);
  const firstStore = new ResourceLeaseStore(state);
  const secondStore = new ResourceLeaseStore(state);
  const key = 'fs-path:/tmp/same-owner-shared';
  const one = await firstStore.acquire('owner', [key], 'shared');
  const two = await secondStore.acquire('owner', [key], 'shared');
  await assert.rejects(
    () => new ResourceLeaseStore(state).acquire('owner', [key], 'exclusive'),
    (error: any) => error?.code === 'RESOURCE_BUSY'
  );
  await two.release();
  await one.release();
});
