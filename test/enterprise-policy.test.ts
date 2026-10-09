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

test('stage16 project scope prefixes respect project-key boundaries', async (t) => {
  const store = new EnterprisePolicyStore(await temp(t));
  await store.configure({
    roles: [{
      id: 'reader',
      capabilities: ['file.read'],
      rootPrefixes: [],
      maxRisk: 'read',
      environments: [],
      projectPrefixes: ['project:alpha'],
      deviceGroups: []
    }],
    bindings: [{
      id: 'reader-binding',
      principalId: 'principal-1',
      roleId: 'reader',
      projectPrefix: 'project:alpha',
      enabled: true
    }]
  });

  await assert.rejects(
    () => store.narrow({ allowedCapabilities: ['file.read'], allowedRoots: [] }, {
      principalId: 'principal-1',
      projectKey: 'project:alphabet'
    }),
    (error: any) => error?.code === 'ENTERPRISE_AUTHORITY_DENIED'
  );

  const allowed = await store.narrow({ allowedCapabilities: ['file.read'], allowedRoots: [] }, {
    principalId: 'principal-1',
    projectKey: 'project:alpha/service'
  });
  assert.deepEqual(allowed.permissions.allowedCapabilities, ['file.read']);
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


test('enterprise policy decisions bind content digest and monotonic generation across A-B-A', async (t) => {
  const root = path.resolve('/tmp/company/freshness');
  const store = new EnterprisePolicyStore(await temp(t));
  const configure = async (capabilities: string[]) => await store.configure({
    roles: [{
      id: 'developer',
      capabilities,
      rootPrefixes: [root],
      maxRisk: 'write',
      environments: [],
      projectPrefixes: [],
      deviceGroups: []
    }],
    bindings: [{
      id: 'developer-binding',
      principalId: 'alice',
      roleId: 'developer',
      enabled: true
    }]
  });

  await configure(['file.read', 'file.write']);
  const decision = await store.narrow({
    allowedCapabilities: ['file.read', 'file.write'],
    allowedRoots: [root],
    maxRisk: 'write'
  }, { principalId: 'alice' });

  assert.match(String(decision.permissions.enterprisePolicyDigest), /^[0-9a-f]{64}$/);
  assert.equal(decision.permissions.enterprisePolicyGeneration, 1);
  await assert.doesNotReject(() => store.assertCurrentAuthority({
    digest: decision.permissions.enterprisePolicyDigest!,
    generation: decision.permissions.enterprisePolicyGeneration!
  }));

  await configure(['file.read']);
  await assert.rejects(
    () => store.assertCurrentAuthority({
      digest: decision.permissions.enterprisePolicyDigest!,
      generation: decision.permissions.enterprisePolicyGeneration!
    }),
    (error: any) => error?.code === 'ENTERPRISE_POLICY_STALE'
      && error?.details?.executionPhase === 'pre_dispatch'
      && error?.details?.sideEffectState === 'none'
  );

  await configure(['file.read', 'file.write']);
  const restored = await store.currentAuthority();
  assert.equal(restored.digest, decision.permissions.enterprisePolicyDigest);
  assert.equal(restored.generation, 3);
  await assert.rejects(
    () => store.assertCurrentAuthority({
      digest: decision.permissions.enterprisePolicyDigest!,
      generation: decision.permissions.enterprisePolicyGeneration!
    }),
    (error: any) => error?.code === 'ENTERPRISE_POLICY_STALE'
      && error?.details?.expectedGeneration === 1
      && error?.details?.actualGeneration === 3
  );
});

test('enterprise policy generation survives restart and identical configuration is idempotent', async (t) => {
  const state = await temp(t);
  const policy = {
    roles: [{
      id: 'reader', capabilities: ['file.read'], rootPrefixes: [], maxRisk: 'read' as const,
      environments: [], projectPrefixes: [], deviceGroups: []
    }],
    bindings: [{ id: 'reader-binding', principalId: 'alice', roleId: 'reader', enabled: true }]
  };
  const first = await new EnterprisePolicyStore(state).configure(policy);
  assert.equal(first.generation, 1);
  const restarted = new EnterprisePolicyStore(state);
  assert.equal((await restarted.inspect()).generation, 1);
  assert.equal((await restarted.configure(policy)).generation, 1);
  assert.equal((await new EnterprisePolicyStore(state).inspect()).generation, 1);
});

test('enterprise policy concurrent updates serialize strictly increasing generations', async (t) => {
  const store = new EnterprisePolicyStore(await temp(t));
  const configure = (id: string) => store.configure({
    roles: [{
      id, capabilities: ['file.read'], rootPrefixes: [], maxRisk: 'read',
      environments: [], projectPrefixes: [], deviceGroups: []
    }],
    bindings: [{ id: `${id}-binding`, principalId: 'alice', roleId: id, enabled: true }]
  });
  assert.equal((await configure('a')).generation, 1);
  const [second, third] = await Promise.all([configure('b'), configure('c')]);
  assert.deepEqual([second.generation, third.generation], [2, 3]);
  assert.equal((await store.inspect()).generation, 3);
});

test('enterprise policy rejects generation tamper and migrates legacy v1 authority', async (t) => {
  const state = await temp(t);
  const file = path.join(state, 'enterprise-policy.json');
  const legacy = {
    version: 1,
    roles: [{
      id: 'legacy', capabilities: ['file.read'], rootPrefixes: [], maxRisk: 'read',
      environments: [], projectPrefixes: [], deviceGroups: [], deviceIds: []
    }],
    bindings: [{ id: 'legacy-binding', principalId: 'alice', roleId: 'legacy', enabled: true }]
  };
  await fs.writeFile(file, JSON.stringify(legacy));
  const store = new EnterprisePolicyStore(state);
  assert.equal((await store.inspect()).generation, 1);
  const updated = await store.configure({
    roles: [{ ...legacy.roles[0]!, capabilities: ['file.read', 'file.write'] }],
    bindings: legacy.bindings
  });
  assert.equal(updated.generation, 2);

  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  raw.generation = 1;
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(
    new EnterprisePolicyStore(state).inspect(),
    (error: any) => error?.code === 'ENTERPRISE_POLICY_CORRUPT'
  );
});

test('independent enterprise policy instances preserve every generation and deduplicate identical policy updates', async (t) => {
  const state = await temp(t);
  const stores = Array.from({ length: 8 }, () => new EnterprisePolicyStore(state));
  const policy = (name: string) => ({
    roles: [{
      id: 'role-' + name,
      capabilities: ['file.read'],
      rootPrefixes: [],
      maxRisk: 'read' as const,
      environments: [],
      projectPrefixes: [],
      deviceGroups: []
    }],
    bindings: [{
      id: 'binding-' + name,
      principalId: 'human:policy-operator',
      roleId: 'role-' + name,
      enabled: true
    }]
  });
  const updates = await Promise.all(Array.from({ length: 16 }, (_, i) =>
    stores[i % stores.length]!.configure(policy(String(i)))
  ));
  assert.deepEqual(updates.map((item) => item.generation).sort((a, b) => a - b),
    Array.from({ length: 16 }, (_, i) => i + 1));
  const current = await new EnterprisePolicyStore(state).inspect();
  assert.equal(current.generation, 16);
  assert.equal(current.roles.length, 1);
  assert.equal(current.bindings.length, 1);
  const finalPolicy = policy('restrict-to-readonly');
  const identical = await Promise.all([stores[0]!.configure(finalPolicy), stores[1]!.configure(finalPolicy)]);
  assert.deepEqual(identical.map((item) => item.generation), [17, 17]);
  const persisted = await new EnterprisePolicyStore(state).inspect();
  assert.equal(persisted.generation, 17);
  assert.equal(persisted.roles[0]?.id, finalPolicy.roles[0]!.id);
  assert.equal(persisted.bindings[0]?.roleId, finalPolicy.roles[0]!.id);
});

test('enterprise root restriction applies even when the base permission profile has unrestricted roots', async (t) => {
  const root = path.resolve(os.tmpdir(), 'enterprise-restricted', 'allowed');
  const outside = path.resolve(os.tmpdir(), 'enterprise-restricted', 'outside');
  const store = new EnterprisePolicyStore(await temp(t));
  await store.configure({
    roles: [{
      id: 'scoped-reader',
      capabilities: ['file.read'],
      rootPrefixes: [root],
      maxRisk: 'read',
      environments: [],
      projectPrefixes: [],
      deviceGroups: []
    }],
    bindings: [{ id: 'scoped-binding', principalId: 'analyst', roleId: 'scoped-reader', enabled: true }]
  });
  const decision = await store.narrow({
    allowedCapabilities: ['file.read'],
    allowedRoots: [] // Base policy's empty roots means no filesystem restriction.
  }, { principalId: 'analyst' });
  assert.deepEqual(decision.permissions.allowedRoots, [root]);

  const policy = new PolicyEngine();
  assert.doesNotThrow(() => policy.authorize({
    id: 'inside-enterprise-root',
    capability: 'file.read',
    risk: 'read',
    input: { path: path.join(root, 'report.txt') },
    provenance: { kind: 'user' }
  }, decision.permissions));
  assert.throws(() => policy.authorize({
    id: 'outside-enterprise-root',
    capability: 'file.read',
    risk: 'read',
    input: { path: path.join(outside, 'report.txt') },
    provenance: { kind: 'user' }
  }, decision.permissions), (error: any) => error?.code === 'PATH_OUTSIDE_SCOPE');
});

test('enterprise roles cannot cross-compose a capability with a different roles filesystem root', async (t) => {
  const rootA = path.resolve(os.tmpdir(), 'role-a-only');
  const rootB = path.resolve(os.tmpdir(), 'role-b-only');
  const store = new EnterprisePolicyStore(await temp(t));
  const role = (id: string, capabilities: string[], rootPrefixes: string[]) => ({
    id, capabilities, rootPrefixes, maxRisk: 'write' as const,
    environments: [], projectPrefixes: [], deviceGroups: []
  });
  const bindings = ['reader-a', 'writer-b'].map((id) => ({
    id: 'binding-' + id, principalId: 'alice', roleId: id, enabled: true
  }));

  await store.configure({
    roles: [role('reader-a', ['file.read'], [rootA]), role('writer-b', ['file.write'], [rootB])],
    bindings
  });
  await assert.rejects(() => store.narrow({
    allowedCapabilities: ['file.read', 'file.write'],
    allowedRoots: [rootA, rootB], maxRisk: 'write'
  }, { principalId: 'alice' }), (error: any) => error?.code === 'ENTERPRISE_AUTHORITY_DENIED');

  // Additive roots for the SAME capability and risk are safe to project:
  // each capability/root/risk tuple remains backed by one of the roles.
  await store.configure({
    roles: [role('reader-a', ['file.read'], [rootA]), role('writer-b', ['file.read'], [rootB])],
    bindings
  });
  const safe = await store.narrow({
    allowedCapabilities: ['file.read'],
    allowedRoots: [rootA, rootB], maxRisk: 'write'
  }, { principalId: 'alice' });
  assert.deepEqual(safe.permissions.allowedCapabilities, ['file.read']);
  assert.deepEqual(safe.permissions.allowedRoots, [rootA, rootB].sort());
});
