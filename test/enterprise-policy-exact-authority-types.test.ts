import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EnterprisePolicyStore } from '../src/core/enterprise-policy.ts';

const policy = {roles:[{
  id:'viewer',capabilities:['file.read'],rootPrefixes:[],maxRisk:'read' as const,
  environments:[],projectPrefixes:[],deviceGroups:[]
}],bindings:[{id:'viewer-one',principalId:'principal:one',roleId:'viewer',enabled:true}]};
test('persisted policy digest is a true string and cannot be array-wrapped', async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'operator-policy-typed-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new EnterprisePolicyStore(root);
  await store.configure(policy);
  const file=path.join(root,'enterprise-policy.json'),state=JSON.parse(await fs.readFile(file,'utf8'));
  state.recordDigest=[state.recordDigest];
  const malformed=JSON.stringify(state);
  await fs.writeFile(file,malformed);
  await assert.rejects(new EnterprisePolicyStore(root).inspect(),
    (e:any)=>e?.code==='ENTERPRISE_POLICY_CORRUPT');
  assert.equal(await fs.readFile(file,'utf8'),malformed);
});
test('current enterprise authorization rejects coerced policy digest and generation',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'operator-policy-check-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new EnterprisePolicyStore(root);
  await store.configure(policy);
  const current=await store.currentAuthority();
  await store.assertCurrentAuthority(current);
  for (const input of [
    {digest:[current.digest],generation:current.generation},
    {digest:current.digest,generation:String(current.generation)},
    {digest:current.digest,generation:[current.generation]}
  ]) {
    await assert.rejects(store.assertCurrentAuthority(input as any),
      (e:any)=>e?.code==='ENTERPRISE_POLICY_AUTHORITY_INVALID');
  }
});

test('C08 enterprise narrowing never inherits a malformed parent risk ceiling', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'operator-enterprise-parent-risk-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new EnterprisePolicyStore(root);
  await store.configure(policy);
  const base={allowedCapabilities:['file.read'],allowedRoots:[],maxRisk:'destructive' as const};
  const valid=await store.narrow(base,{principalId:'principal:one'});
  assert.equal(valid.permissions.maxRisk,'read');
  for(const risk of ['toString','constructor','__proto__','unknown','READ',null,false,0,{}]) {
    await assert.rejects(
      ()=>store.narrow({...base,maxRisk:risk as any},{principalId:'principal:one'}),
      (error:any)=>error?.code==='ENTERPRISE_AUTHORITY_INVALID',
      String(risk)
    );
  }
  const ordinary=await store.narrow({allowedCapabilities:['file.read'],allowedRoots:[]},{principalId:'principal:one'});
  assert.equal(ordinary.permissions.maxRisk,'read');
});
