import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EnterpriseIdentityStore } from '../src/core/enterprise-identity.ts';

async function fixture(t:test.TestContext){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'operator-identity-types-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=new EnterpriseIdentityStore(root);
 await store.configureProviders([{id:'provider-one',issuer:'https://login.example.invalid',audiences:['client-one'],enabled:true}]);
 await store.upsertScimUser({providerId:'provider-one',subject:'subject-123',principalId:'tenant-user-1',roleIds:['reader'],active:true});
 return {root,store};
}
for(const [kind,field] of [['provider','id'],['subject','providerId'],['subject','principalId'],['subject','roleIds']] as const){
 test('enterprise SSO state refuses coerced '+kind+'.'+field,async t=>{
  const {root}=await fixture(t);
  const f=path.join(root,'enterprise-identity.json');
  const s=JSON.parse(await fs.readFile(f,'utf8'));
  const record=kind==='provider'?s.providers[0]:s.subjects[0];
  record[field]=field==='roleIds'?[['reader']]:[record[field]];
  const malformed=JSON.stringify(s);
  await fs.writeFile(f,malformed);
  await assert.rejects(new EnterpriseIdentityStore(root).inspect(),(e:any)=>['ENTERPRISE_IDENTITY_INVALID','ENTERPRISE_IDENTITY_CORRUPT'].includes(e?.code));
  assert.equal(await fs.readFile(f,'utf8'),malformed);
 });
}
test('enterprise SSO rejects coerced caller provider identity and SCIM principal',async t=>{
 const {root,store}=await fixture(t);
 await assert.rejects(store.resolveSso({providerId:['provider-one'],issuer:'https://login.example.invalid',audience:'client-one',subject:'subject-123',verified:true} as any),
   (e:any)=>e?.code==='ENTERPRISE_IDENTITY_INVALID');
 await assert.rejects(store.upsertScimUser({providerId:'provider-one',subject:'subject-new',principalId:['tenant-user-2']} as any),
   (e:any)=>e?.code==='ENTERPRISE_IDENTITY_INVALID');
 assert.equal((await store.inspect()).subjects.length,1);
});
