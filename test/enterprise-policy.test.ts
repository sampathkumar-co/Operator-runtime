import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EnterprisePolicyStore } from '../src/core/enterprise-policy.ts';

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
