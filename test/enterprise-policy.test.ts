import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EnterprisePolicyStore } from '../src/core/enterprise-policy.ts';
import { PolicyEngine } from '../src/core/policy.ts';

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-enterprise-policy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('stage16 enterprise roles only narrow local machine authority', async (t) => {
  const root = path.resolve('/tmp/company/project');
  const store = new EnterprisePolicyStore(await temp(t));
  await store.configure({
    roles: [{
      id: 'developer',
      capabilities: ['file.*', 'docker.*'],
      rootPrefixes: [root],
      maxRisk: 'destructive',
      environments: ['prod'],
      projectPrefixes: ['project:payments'],
      deviceGroups: ['prod-runners']
    }],
    bindings: [{
      id: 'alice-prod',
      principalId: 'alice@example.com',
      roleId: 'developer',
      projectPrefix: 'project:payments',
      environment: 'prod',
      deviceGroup: 'prod-runners',
      enabled: true
    }]
  });

  const decision = await store.narrow({
    allowedCapabilities: ['file.read', 'file.write', 'browser.inspect'],
    allowedRoots: [root, path.resolve('/tmp/other')],
    allowExternalWrites: false,
    allowSystemChanges: false,
    allowDestructive: false
  }, {
    principalId: 'alice@example.com',
    projectKey: 'project:payments/api',
    environment: 'prod',
    deviceGroups: ['prod-runners']
  });

  assert.deepEqual(decision.permissions.allowedCapabilities, ['file.read', 'file.write']);
  assert.deepEqual(decision.permissions.allowedRoots, [root]);
  assert.equal(decision.permissions.allowExternalWrites, false);
  assert.equal(decision.permissions.allowSystemChanges, false);
  assert.equal(decision.permissions.allowDestructive, false);
});

test('stage16 context constraints fail closed outside assigned project/environment', async (t) => {
  const store = new EnterprisePolicyStore(await temp(t));
  await store.configure({
    roles: [{
      id: 'reader',
      capabilities: ['file.read'],
      rootPrefixes: [],
      maxRisk: 'read',
      environments: ['staging'],
      projectPrefixes: ['project:alpha'],
      deviceGroups: []
    }],
    bindings: [{
      id: 'reader-binding',
      principalId: 'principal-1',
      roleId: 'reader',
      enabled: true
    }]
  });
  await assert.rejects(
    () => store.narrow({ allowedCapabilities: ['file.read'], allowedRoots: [] }, {
      principalId: 'principal-1',
      projectKey: 'project:beta',
      environment: 'prod'
    }),
    (error: any) => error?.code === 'ENTERPRISE_AUTHORITY_DENIED'
  );
});


test('stage16 intersects wildcard capabilities and parent roots instead of accidentally dropping narrower grants', async (t) => {
  const parent = path.resolve('/tmp/company');
  const project = path.join(parent, 'payments');
  const store = new EnterprisePolicyStore(await temp(t));
  await store.configure({
    roles: [{
      id: 'payments-reader',
      capabilities: ['file.read'],
      rootPrefixes: [project],
      maxRisk: 'read',
      environments: [],
      projectPrefixes: [],
      deviceGroups: [],
      deviceIds: ['device-a']
    }],
    bindings: [{
      id: 'payments-device',
      principalId: 'alice',
      roleId: 'payments-reader',
      deviceId: 'device-a',
      enabled: true
    }]
  });

  const decision = await store.narrow({
    allowedCapabilities: ['file.*', 'browser.*'],
    allowedRoots: [parent],
    maxRisk: 'destructive',
    allowDestructive: true
  }, {
    principalId: 'alice',
    deviceId: 'device-a'
  });

  assert.deepEqual(decision.permissions.allowedCapabilities, ['file.read']);
  assert.deepEqual(decision.permissions.allowedRoots, [project]);
  assert.equal(decision.permissions.maxRisk, 'read');
  assert.equal(decision.permissions.allowDestructive, false);

  await assert.rejects(
    () => store.narrow({ allowedCapabilities: ['file.*'], allowedRoots: [parent] }, {
      principalId: 'alice',
      deviceId: 'device-b'
    }),
    (error: any) => error?.code === 'ENTERPRISE_AUTHORITY_DENIED'
  );
});

test('stage16 maxRisk is a hard ceiling that approval IDs cannot bypass', async (t) => {
  const root = path.resolve('/tmp/company/readonly');
  const store = new EnterprisePolicyStore(await temp(t));
  await store.configure({
    roles: [{
      id: 'readonly-role',
      capabilities: ['file.*'],
      rootPrefixes: [root],
      maxRisk: 'read',
      environments: [],
      projectPrefixes: [],
      deviceGroups: []
    }],
    bindings: [{
      id: 'readonly-binding',
      principalId: 'reader',
      roleId: 'readonly-role',
      enabled: true
    }]
  });

  const decision = await store.narrow({
    allowedCapabilities: ['file.read', 'file.write'],
    allowedRoots: [root],
    maxRisk: 'destructive',
    approvedActionIds: ['approved-write'],
    allowDestructive: true
  }, { principalId: 'reader' });

  assert.deepEqual(decision.permissions.allowedCapabilities, ['file.read', 'file.write']);
  assert.equal(decision.permissions.maxRisk, 'read');

  const policy = new PolicyEngine();
  assert.doesNotThrow(() => policy.authorize({
    id: 'read',
    capability: 'file.read',
    risk: 'read',
    input: { path: path.join(root, 'a.txt') },
    provenance: { kind: 'user' }
  }, decision.permissions));

  assert.throws(() => policy.authorize({
    id: 'approved-write',
    capability: 'file.write',
    risk: 'write',
    input: { path: path.join(root, 'a.txt') },
    provenance: { kind: 'user' }
  }, decision.permissions), (error: any) => error?.code === 'RISK_CEILING_EXCEEDED');
});

test('stage16 role grants cannot widen an already narrower parent risk ceiling', async (t) => {
  const store = new EnterprisePolicyStore(await temp(t));
  await store.configure({
    roles: [{
      id: 'admin-role',
      capabilities: ['file.read'],
      rootPrefixes: [],
      maxRisk: 'destructive',
      environments: [],
      projectPrefixes: [],
      deviceGroups: []
    }],
    bindings: [{ id: 'admin-binding', principalId: 'admin', roleId: 'admin-role', enabled: true }]
  });
  const decision = await store.narrow({
    allowedCapabilities: ['file.read'],
    allowedRoots: [],
    maxRisk: 'write',
    allowDestructive: true
  }, { principalId: 'admin' });
  assert.equal(decision.permissions.maxRisk, 'write');
  assert.equal(decision.permissions.allowDestructive, false);
});
