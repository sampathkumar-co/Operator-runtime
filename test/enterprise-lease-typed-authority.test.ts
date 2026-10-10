import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EnterpriseAuthorityLeaseStore } from '../src/core/enterprise-authority-lease.ts';

test('enterprise lease issuance and revocation reject coerced authority identities', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-enterprise-typed-authority-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new EnterpriseAuthorityLeaseStore(dir);
  const request = {
    principalId: 'human:owner', purpose: 'explicitly approved work',
    authorityRevision: 7, ttlMs: 60_000,
    grant: { capabilities: ['files.read'], resourcePrefixes: ['project:safe'], maxRisk: 'read' as const }
  };
  const lease = await store.issue(request);
  assert.equal((await store.assertActive(lease.id)).id, lease.id);
  for (const malformed of [
    { ...request, authorityRevision: '7' },
    { ...request, authorityRevision: [7] },
    { ...request, ttlMs: '60000' },
    { ...request, principalId: ['human:owner'] }
  ]) {
    await assert.rejects(store.issue(malformed as any),
      (error: any) => error?.code === 'ENTERPRISE_AUTHORITY_LEASE_INVALID');
  }
  for (const id of [[lease.id], { toString: () => lease.id }]) {
    await assert.rejects(store.assertActive(id as any),
      (error: any) => error?.code === 'ENTERPRISE_AUTHORITY_LEASE_INVALID');
    await assert.rejects(store.revoke(id as any, 'test revocation'),
      (error: any) => error?.code === 'ENTERPRISE_AUTHORITY_LEASE_INVALID');
  }
  assert.equal((await store.assertActive(lease.id)).state, 'ACTIVE');
});

test('enterprise persisted lease rejects coerced generation and timestamp after restart', async (t) => {
  for (const field of ['authorityRevision', 'issuedAt', 'expiresAt'] as const) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-enterprise-persisted-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const store = new EnterpriseAuthorityLeaseStore(dir);
    const lease = await store.issue({
      principalId: 'human:owner', purpose: 'audited scope', authorityRevision: 3, ttlMs: 60_000,
      grant: { capabilities: ['files.read'], resourcePrefixes: ['project:safe'], maxRisk: 'read' }
    });
    const file = path.join(dir, 'enterprise-authority-leases.json');
    const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
    persisted.leases[0][field] = field === 'authorityRevision' ? '3' : [lease[field]];
    await fs.writeFile(file, JSON.stringify(persisted), { mode: 0o600 });
    await assert.rejects(new EnterpriseAuthorityLeaseStore(dir).assertActive(lease.id),
      (error: any) => ['ENTERPRISE_AUTHORITY_LEASE_INVALID', 'ENTERPRISE_AUTHORITY_LEASE_CORRUPT'].includes(error?.code));
  }
});
