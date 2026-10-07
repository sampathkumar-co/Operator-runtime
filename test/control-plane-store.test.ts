import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EmbeddedControlPlaneStore } from '../src/core/control-plane-store.ts';
import { RelayClusterCoordinator } from '../src/core/relay-cluster-control.ts';

test('control-plane CAS rejects stale writers atomically', async (t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-cp-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new EmbeddedControlPlaneStore(dir);
  const [first]=await store.transact([{namespace:'n',key:'k',expectedGeneration:null,value:{v:1}}],'2026-10-07T00:00:00.000Z');
  await assert.rejects(store.transact([{namespace:'n',key:'k',expectedGeneration:first!.generation+1,value:{v:2}}],'2026-10-07T00:00:01.000Z'),(e:any)=>e?.code==='CONTROL_PLANE_CAS_MISMATCH');
  assert.equal((await store.get('n','k'))?.value.v,1);
});

test('snapshot restore is digest-bound and coherent', async (t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-cp-snap-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new EmbeddedControlPlaneStore(dir);
  await store.transact([{namespace:'a',key:'1',expectedGeneration:null,value:{x:'one'}},{namespace:'a',key:'2',expectedGeneration:null,value:{x:'two'}}],'2026-10-07T00:00:00.000Z');
  const snap=await store.snapshot('2026-10-07T00:00:01.000Z');
  const first=(await store.get('a','1'))!;
  await store.transact([{namespace:'a',key:'1',expectedGeneration:first.generation,value:{x:'changed'}}],'2026-10-07T00:00:02.000Z');
  await store.restore(snap);
  assert.equal((await store.get('a','1'))?.value.x,'one');
  const tampered=structuredClone(snap);tampered.records[0]!.value={x:'evil'};
  await assert.rejects(store.restore(tampered),(e:any)=>e?.code==='CONTROL_PLANE_STORE_INVALID'||e?.code==='CONTROL_PLANE_STORE_CORRUPT');
});

test('relay cluster coordinator fences split brain and allows handoff after release', async (t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-cluster-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new EmbeddedControlPlaneStore(dir);
  const cluster=new RelayClusterCoordinator(store);
  const one=await cluster.acquire('device:1','relay-a',30_000,'2026-10-07T00:00:00.000Z');
  await assert.rejects(cluster.acquire('device:1','relay-b',30_000,'2026-10-07T00:00:01.000Z'),(e:any)=>e?.code==='RELAY_CLUSTER_RESOURCE_FENCED');
  await cluster.release(one,'2026-10-07T00:00:02.000Z');
  const two=await cluster.acquire('device:1','relay-b',30_000,'2026-10-07T00:00:03.000Z');
  assert.equal(two.instanceId,'relay-b');
  assert.ok(two.generation>=1);
  await assert.rejects(cluster.assertCurrent(one,'2026-10-07T00:00:04.000Z'),(e:any)=>e?.code==='RELAY_CLUSTER_FENCE_STALE'||e?.code==='RELAY_CLUSTER_FENCE_LOST');
});
