import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EnterpriseAuthorityLeaseStore } from '../src/core/enterprise-authority-lease.ts';

const grant = { capabilities: ['files.read'], resourcePrefixes: ['project:verified'],
  maxRisk: 'read' as const };
const input = (principalId: string, parentLeaseId?: string) => ({
  principalId, purpose: 'audited shared-authority scope', grant, authorityRevision: 7,
  ttlMs: 60_000, ...(parentLeaseId ? { parentLeaseId } : {})
});
async function fresh(t: test.TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-enterprise-cross-instance-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { left: new EnterpriseAuthorityLeaseStore(dir), right: new EnterpriseAuthorityLeaseStore(dir),
    reopened: () => new EnterpriseAuthorityLeaseStore(dir) };
}

test('independent authority writers never lose concurrently issued grants', async t => {
  const {left,right,reopened} = await fresh(t);
  const expected = Array.from({length:12},(_,i)=>'human:collision-'+i);
  const settled = await Promise.allSettled(expected.map((p,i)=>
    (i % 2 ? left : right).issue(input(p))));
  assert.equal(settled.filter(r=>r.status==='fulfilled').length,12,
    'independent persistence queues must not overwrite concurrent grants');
  const recorded = await reopened().list();
  assert.equal(recorded.length,12);
  assert.deepEqual(new Set(recorded.map(r=>r.principalId)),new Set(expected));
  assert.equal(new Set(recorded.map(r=>r.id)).size,12);
});

test('independent parent revocation vs child issuance never leaves a live child', async t => {
  for(let iteration=0;iteration<12;iteration++){
    const {left,right,reopened}=await fresh(t);
    const parent=await left.issue(input('human:root-'+iteration));
    const [revoke,issue]=await Promise.allSettled([
      left.revoke(parent.id,'external security revocation'),
      right.issue(input('agent:child-'+iteration,parent.id))
    ]);
    assert.equal(revoke.status,'fulfilled');
    if(issue.status==='rejected'){
      assert.equal((issue.reason as any)?.code,'ENTERPRISE_PARENT_LEASE_INVALID');
    }
    const freshStore=reopened();
    const saved=await freshStore.list();
    assert.equal(saved.find(r=>r.id===parent.id)?.state,'REVOKED');
    assert.ok(saved.every(r=>r.state!=='ACTIVE'),
      'a racing child cannot outlive its revoked parent');
    if(issue.status==='fulfilled'){
      await assert.rejects(freshStore.assertActive(issue.value.id),
        (e:any)=>e?.code==='ENTERPRISE_AUTHORITY_LEASE_INACTIVE');
    }
  }
});

test('independent emergency halt vs issuance cannot admit active authority after restart',async t=>{
  for(let iteration=0;iteration<12;iteration++){
    const {left,right,reopened}=await fresh(t);
    const [halt,issue]=await Promise.allSettled([
      left.emergencyHalt('emergency authorized stop'),
      right.issue(input('human:halt-race-'+iteration))
    ]);
    assert.equal(halt.status,'fulfilled');
    if(issue.status==='rejected'){
      assert.equal((issue.reason as any)?.code,'ENTERPRISE_EMERGENCY_HALTED');
    }
    const saved=await reopened().list();
    assert.ok(saved.every(r=>r.state!=='ACTIVE'),
      'emergency halt cannot be lost to an independent concurrent issue');
    if(issue.status==='fulfilled'){
      await assert.rejects(reopened().assertActive(issue.value.id),
        (e:any)=>e?.code==='ENTERPRISE_EMERGENCY_HALTED');
    }
    await assert.rejects(reopened().issue(input('agent:after-halt-'+iteration)),
      (e:any)=>e?.code==='ENTERPRISE_EMERGENCY_HALTED');
  }
});
