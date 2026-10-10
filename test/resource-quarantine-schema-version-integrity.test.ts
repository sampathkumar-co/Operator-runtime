import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {ResourceLeaseStore} from '../src/core/resource-leases.ts';

test('malformed durable lease format cannot downgrade v2 and discard quarantined actions',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'operator-quarantine-schema-integrity-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'resource-leases.json');
  const originalStore=new ResourceLeaseStore(dir);
  await originalStore.quarantine('pending-external-effect',['device:one']);
  const original=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(original.version,2);
  assert.equal(original.quarantines.length,1);
  for(const malformed of [true,'1','2',[1],[2],null]) {
    const damaged={...structuredClone(original),version:malformed};
    await fs.writeFile(file,JSON.stringify(damaged));
    await assert.rejects(()=>new ResourceLeaseStore(dir).inspect(),
      (e:any)=>e?.code==='RESOURCE_LEASE_CORRUPT',
      'invalid schema version must not be interpreted as the legacy schema');
    await assert.rejects(()=>new ResourceLeaseStore(dir).acquire('unrelated-owner',['device:one'],'exclusive'),
      (e:any)=>e?.code==='RESOURCE_LEASE_CORRUPT',
      'invalid persisted version must block mutation before losing quarantine');
    assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),damaged);
  }
  await fs.writeFile(file,JSON.stringify(original));
  await assert.rejects(()=>new ResourceLeaseStore(dir).acquire('unrelated-owner',['device:one'],'exclusive'),
    (e:any)=>e?.code==='RESOURCE_QUARANTINED');
  const refreshed=await new ResourceLeaseStore(dir).inspect();
  assert.equal(refreshed.quarantines.length,1);
});
