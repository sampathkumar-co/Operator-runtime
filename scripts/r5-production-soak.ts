import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EmbeddedControlPlaneStore } from '../src/core/control-plane-store.ts';
import { RelayClusterCoordinator } from '../src/core/relay-cluster-control.ts';
import { createUpdateRollout, evaluateProductionSlo, recordUpdateWaveResult, startUpdateRollout } from '../src/core/production-trust-platform.ts';

type Options={iterations?:number;durationMs?:number};
function parse(argv:string[]):Options{
  const out:Options={};
  for(const arg of argv){
    if(arg.startsWith('--iterations=')) out.iterations=positiveInt(arg.slice(13),'iterations');
    else if(arg.startsWith('--duration-ms=')) out.durationMs=positiveInt(arg.slice(14),'duration-ms');
    else throw new Error('Unknown argument: '+arg);
  }
  if(out.iterations===undefined&&out.durationMs===undefined) out.iterations=1_000;
  return out;
}
function positiveInt(v:string,label:string):number{const n=Number(v);if(!Number.isSafeInteger(n)||n<1)throw new Error(label+' must be a positive integer.');return n;}

const options=parse(process.argv.slice(2));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-r5-soak-'));
const started=Date.now();
let iterations=0, staleFenceRejections=0, casRejections=0, restoreChecks=0;
try{
  const store=new EmbeddedControlPlaneStore(root);
  const cluster=new RelayClusterCoordinator(store);
  const deadline=options.durationMs?started+options.durationMs:Number.POSITIVE_INFINITY;
  while((options.iterations===undefined||iterations<options.iterations)&&Date.now()<deadline){
    const baseMs=Date.parse('2026-10-07T00:00:00.000Z')+iterations*20_000;
    const t=(offset:number)=>new Date(baseMs+offset).toISOString();
    const key='device:'+String(iterations%32);
    const a=await cluster.acquire(key,'relay-a',5_000,t(0));
    await assert.rejects(cluster.acquire(key,'relay-b',5_000,t(1_000)),(e:any)=>{
      if(e?.code==='RELAY_CLUSTER_RESOURCE_FENCED'){staleFenceRejections+=1;return true;}return false;
    });
    const b=await cluster.acquire(key,'relay-b',5_000,t(6_000));
    assert.ok(b.generation>a.generation);
    await assert.rejects(cluster.assertCurrent(a,t(6_001)),(e:any)=>{
      if(['RELAY_CLUSTER_FENCE_STALE','RELAY_CLUSTER_FENCE_LOST'].includes(e?.code)){staleFenceRejections+=1;return true;}return false;
    });
    await cluster.release(b,t(7_000));

    const recordKey='r'+String(iterations%64);
    const current=await store.get('soak',recordKey);
    if(current){
      await assert.rejects(store.transact([{namespace:'soak',key:recordKey,expectedGeneration:current.generation+1,value:{i:iterations}}],t(8_000)),(e:any)=>{
        if(e?.code==='CONTROL_PLANE_CAS_MISMATCH'){casRejections+=1;return true;}return false;
      });
      await store.transact([{namespace:'soak',key:recordKey,expectedGeneration:current.generation,value:{i:iterations}}],t(9_000));
    }else{
      await store.transact([{namespace:'soak',key:recordKey,expectedGeneration:null,value:{i:iterations}}],t(9_000));
    }

    if(iterations%50===0){
      const snapshot=await store.snapshot(t(10_000));
      const restoreDir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-r5-soak-restore-'));
      try{
        const restored=new EmbeddedControlPlaneStore(restoreDir);
        await restored.restore(snapshot);
        assert.equal((await restored.snapshot(t(10_001))).records.length,snapshot.records.length);
        restoreChecks+=1;
      }finally{await fs.rm(restoreDir,{recursive:true,force:true});}
    }

    const slo=evaluateProductionSlo({
      operation:{traces:100,completed:100,blocked:0,failed:0,uncertain:0,verified:100,completionRate:1,verificationRate:1,falseCompletionCount:0,p50CompletionMs:100,p95CompletionMs:250},
      crashFreeSessionRate:1,updateSuccessRate:1
    },{minVerificationRate:.99,maxFalseCompletionRate:0,maxUncertainRate:.01,maxP95CompletionMs:20_000,minCrashFreeSessionRate:.999,minUpdateSuccessRate:.99});
    let rollout=startUpdateRollout(createUpdateRollout({version:'9.9.9',channel:'canary',waves:[{id:'canary',targetCount:1,minHealthyCount:1}],now:t(11_000)}),t(11_001));
    rollout=recordUpdateWaveResult({state:rollout,completedTargets:1,healthyTargets:1,rollbackAvailable:true,slo,now:t(12_000)});
    assert.equal(rollout.state,'COMPLETED');
    iterations+=1;
  }
  const result={ok:true,iterations,durationMs:Date.now()-started,staleFenceRejections,casRejections,restoreChecks};
  process.stdout.write(JSON.stringify(result)+'\n');
}finally{
  await fs.rm(root,{recursive:true,force:true});
}
