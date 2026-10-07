import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EmbeddedControlPlaneStore } from '../src/core/control-plane-store.ts';
import { RelayClusterCoordinator } from '../src/core/relay-cluster-control.ts';

test('expired relay owner cannot resume after another instance acquires the resource', async (t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-r5-fault-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new EmbeddedControlPlaneStore(dir);const c=new RelayClusterCoordinator(store);
  const a=await c.acquire('delivery:42','a',5_000,'2026-10-07T00:00:00.000Z');
  const b=await c.acquire('delivery:42','b',5_000,'2026-10-07T00:00:06.000Z');
  assert.ok(b.generation>a.generation);
  await assert.rejects(c.assertCurrent(a,'2026-10-07T00:00:06.001Z'),(e:any)=>['RELAY_CLUSTER_FENCE_STALE','RELAY_CLUSTER_FENCE_LOST'].includes(e?.code));
});

test('multi-record transaction is all-or-nothing on stale generation', async (t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-r5-txn-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new EmbeddedControlPlaneStore(dir);
  const [a,b]=await store.transact([
    {namespace:'x',key:'a',expectedGeneration:null,value:{n:1}},
    {namespace:'x',key:'b',expectedGeneration:null,value:{n:1}}
  ],'2026-10-07T00:00:00.000Z');
  await assert.rejects(store.transact([
    {namespace:'x',key:'a',expectedGeneration:a!.generation,value:{n:2}},
    {namespace:'x',key:'b',expectedGeneration:b!.generation+1,value:{n:2}}
  ],'2026-10-07T00:00:01.000Z'),(e:any)=>e?.code==='CONTROL_PLANE_CAS_MISMATCH');
  assert.equal((await store.get('x','a'))?.value.n,1);
  assert.equal((await store.get('x','b'))?.value.n,1);
});
