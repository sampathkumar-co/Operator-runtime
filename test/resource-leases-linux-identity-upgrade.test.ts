import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ResourceLeaseStore } from '../src/core/resource-leases.ts';

test('Linux process identity format upgrade cannot unilaterally evict a live pre-upgrade execution lease',async t=>{
  const state=await fs.mkdtemp(path.join(os.tmpdir(),'operator-lease-linux-upgrade-'));
  t.after(()=>fs.rm(state,{recursive:true,force:true}));
  const key='repo:/tmp/critical-durable-owner';
  const legacy={pid:47111,started:'linux-boot-ticks:900001'};
  await fs.writeFile(path.join(state,'resource-leases.json'),JSON.stringify({
    version:2,
    resources:[{key,holders:[{
      leaseId:'33333333-3333-4333-8333-333333333333',
      ownerId:'critical-old-holder',pid:legacy.pid,processInstance:legacy,
      mode:'exclusive',acquiredAt:new Date().toISOString()
    }]}],quarantines:[]
  }));
  const store=new ResourceLeaseStore(state,{
    processInstance:{pid:47222,started:'linux-boot-id:11111111-1111-4111-8111-111111111111:ticks:900002'},
    observeProcessInstance:async pid=>({status:'live',identity:{
      pid,started:'linux-boot-id:11111111-1111-4111-8111-111111111111:ticks:900001'
    }})
  });
  await assert.rejects(store.acquire('unsafe-replacement',[key],'exclusive'),
    (error:any)=>error?.code==='RESOURCE_BUSY',
    'same live process after boot-id metadata upgrade must retain its durable exclusive lease');
  const stored=JSON.parse(await fs.readFile(path.join(state,'resource-leases.json'),'utf8'));
  assert.equal(stored.resources[0].holders[0].ownerId,'critical-old-holder');
});

test('genuine PID reuse with complete comparable identities can still reclaim dead owner', async t=>{
  const state=await fs.mkdtemp(path.join(os.tmpdir(),'operator-lease-pid-reuse-'));
  t.after(()=>fs.rm(state,{recursive:true,force:true}));
  const key='repo:/tmp/pid-reuse';
  const original={pid:47333,started:'linux-boot-id:11111111-1111-4111-8111-111111111111:ticks:20'};
  await fs.writeFile(path.join(state,'resource-leases.json'),JSON.stringify({
    version:2,resources:[{key,holders:[{leaseId:'44444444-4444-4444-8444-444444444444',
      ownerId:'stale-old-holder',pid:original.pid,processInstance:original,
      mode:'exclusive',acquiredAt:new Date().toISOString()}]}],quarantines:[]
  }));
  const store=new ResourceLeaseStore(state,{
    processInstance:{pid:47444,started:'another-process'},
    observeProcessInstance:async pid=>({status:'live',identity:{pid,
      started:'linux-boot-id:11111111-1111-4111-8111-111111111111:ticks:21'}})
  });
  const replacement=await store.acquire('new-owner',[key],'exclusive');
  await replacement.assertOwned();
  await replacement.release();
});
