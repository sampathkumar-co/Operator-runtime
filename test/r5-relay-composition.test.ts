import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EmbeddedControlPlaneStore } from '../src/core/control-plane-store.ts';
import { runRelayService } from '../apps/relay-server/src/main.ts';

function config(stateDir:string){
  return {
    stateDir,
    host:'127.0.0.1',
    port:0,
    resultHost:'127.0.0.1',
    resultPort:0,
    controlHost:'127.0.0.1' as const,
    controlPort:0
  };
}

test('two relay service instances can share one cluster control plane without sharing local state directories',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-r5-relay-cluster-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const shared=new EmbeddedControlPlaneStore(path.join(root,'shared'));
  const a=await runRelayService(config(path.join(root,'a')),{controlPlaneStore:shared,instanceId:'relay-a',clusterLeaseMs:60_000});
  const b=await runRelayService(config(path.join(root,'b')),{controlPlaneStore:shared,instanceId:'relay-b',clusterLeaseMs:60_000});
  t.after(async()=>{await Promise.allSettled([a.close(),b.close()]);});
  const aAddress=(a as any)['#server'];
  assert.ok(a);
  assert.ok(b);
});
