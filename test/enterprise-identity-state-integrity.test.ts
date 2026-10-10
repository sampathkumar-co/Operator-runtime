import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EnterpriseIdentityStore } from '../src/core/enterprise-identity.ts';

const provider = { id: 'corp', issuer: 'https://id.example.net', audiences: ['mecord'], enabled: true };

test('enterprise identity corruption never silently truncates SCIM users during another write', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-enterprise-identity-integrity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'enterprise-identity.json');
  const store = new EnterpriseIdentityStore(dir);
  await store.configureProviders([provider]);
  await store.upsertScimUser({ providerId: 'corp', subject: 'alice', principalId: 'human:alice',
    roleIds: ['admin'], groups: ['engineering'], active: true });
  const pristine = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, any>;
  assert.equal(pristine.subjects.length, 1);

  for (const corrupt of [
    { label: 'missing subject array', value: (() => { const x = structuredClone(pristine); delete x.subjects; return x; })() },
    { label: 'missing subject enabled flag', value: (() => { const x = structuredClone(pristine); delete x.subjects[0].enabled; return x; })() },
    { label: 'missing provider enabled flag', value: (() => { const x = structuredClone(pristine); delete x.providers[0].enabled; return x; })() }
  ]) {
    await fs.writeFile(file, JSON.stringify(corrupt.value));
    await assert.rejects(store.inspect(), (e: any) => e?.code === 'ENTERPRISE_IDENTITY_CORRUPT', corrupt.label);
    await assert.rejects(store.upsertScimUser({
      providerId: 'corp', subject: 'bob', principalId: 'human:bob', active: true
    }), (e: any) => e?.code === 'ENTERPRISE_IDENTITY_CORRUPT', corrupt.label);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), corrupt.value, 'rejected update must not overwrite malformed state');
  }

  await fs.writeFile(file, JSON.stringify(pristine));
  const reloaded = await new EnterpriseIdentityStore(dir).resolveSso({
    providerId: 'corp', issuer: provider.issuer, audience: 'mecord', subject: 'alice', verified: true
  });
  assert.equal(reloaded.principalId, 'human:alice');
});

test('enterprise identities from independent instances remain durable under simultaneous SCIM upserts and revocation', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-enterprise-identity-writers-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stores = Array.from({ length: 5 }, () => new EnterpriseIdentityStore(dir));
  await stores[0]!.configureProviders([provider]);
  await Promise.all(Array.from({ length: 15 }, (_, i) => stores[i % 5]!.upsertScimUser({
    providerId: 'corp', subject: 'user-' + i, principalId: 'human:' + i,
    roleIds: ['viewer'], groups: ['staff'], active: true
  })));
  await Promise.all([
    stores[0]!.deactivateScimUser('corp', 'user-0'),
    ...Array.from({ length: 10 }, (_, i) => stores[(i + 1) % 5]!.upsertScimUser({
      providerId: 'corp', subject: 'late-' + i, principalId: 'human:late-' + i,
      roleIds: ['viewer'], groups: ['staff'], active: true
    }))
  ]);
  const result = await new EnterpriseIdentityStore(dir).inspect();
  assert.equal(result.subjects.length, 25);
  assert.equal(result.subjects.find(x => x.subject === 'user-0')?.enabled, false);
});
