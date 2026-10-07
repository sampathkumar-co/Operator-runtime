import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EmbeddedControlPlaneStore } from '../src/core/control-plane-store.ts';
import {
  DistributedEngineeringFabric,
  compileDistributedIsolation,
  createDistributedLineage,
  rankDistributedWorkers,
  type DistributedWorkOrder,
  type DistributedWorkerAdvertisement
} from '../src/core/distributed-engineering-fabric.ts';

const sha=(value:string)=>crypto.createHash('sha256').update(value,'utf8').digest('hex');
const now='2026-10-07T15:00:00.000Z';

function order(overrides:Partial<DistributedWorkOrder>={}):DistributedWorkOrder{
  return {
    schemaVersion:1,
    objectiveId:'objective-9',
    planId:'plan-9',
    workUnitId:'implementation-1',
    authorityDigest:sha('authority'),
    role:'implementation',
    requiredCapabilities:['repo.write','test.run'],
    resourceKeys:['repo:src/app.ts'],
    securityClass:'sensitive',
    minPosture:'managed',
    minMemoryMb:4096,
    requireGpu:false,
    requiredPorts:1,
    requiredArtifactDigests:[sha('repo-snapshot')],
    dataLocalityTags:['project:alpha'],
    allowedIsolationModes:['container','vm'],
    maxLatencyMs:1000,
    maxCostMicros:1000,
    minTrustScore:0.8,
    minReliabilityScore:0.8,
    leaseMs:10_000,
    ...overrides
  };
}

function worker(id:string,overrides:Partial<DistributedWorkerAdvertisement>={}):DistributedWorkerAdvertisement{
  return {
    schemaVersion:1,
    workerId:id,
    deviceId:'device-'+id,
    sessionId:'session-'+id,
    role:'implementation',
    os:'linux',
    capabilities:['repo.write','test.run','repo.read'],
    tags:['pool:engineering'],
    securityClearance:'restricted',
    posture:'trusted',
    cpuSlots:8,
    memoryMb:32768,
    gpu:false,
    availablePorts:20,
    activeJobs:0,
    maxConcurrentJobs:8,
    artifactDigests:[sha('repo-snapshot')],
    dataLocalityTags:['project:alpha'],
    isolationModes:['container','vm'],
    latencyMs:50,
    estimatedCostMicros:800,
    trustScore:0.98,
    reliabilityScore:0.99,
    observedAt:now,
    ...overrides
  };
}

test('R9 scheduler places only inside authority, posture, quality and isolation constraints',()=>{
  const lowTrust=worker('cheap-untrusted',{estimatedCostMicros:1,trustScore:0.3,reliabilityScore:0.4});
  const cheap=worker('cheap-qualified',{
    artifactDigests:[],dataLocalityTags:[],estimatedCostMicros:100,trustScore:0.82,reliabilityScore:0.83,posture:'managed'
  });
  const best=worker('best');
  const decision=rankDistributedWorkers(order(),[lowTrust,cheap,best],now);
  assert.equal(decision.selectedWorkerId,'best');
  assert.equal(decision.candidates.find((item)=>item.worker.workerId==='cheap-untrusted')?.eligible,false);
  const isolation=compileDistributedIsolation(order(),decision);
  assert.equal(isolation.workspace,'disposable');
  assert.equal(isolation.dataPolicy,'artifact-only');
  assert.equal(isolation.exchangeMode,'content-addressed-artifacts-only');
  assert.equal(isolation.rawSecretExchangeAllowed,false);
  assert.equal(isolation.networkPolicy,'deny-by-default');
  assert.equal(isolation.mode,'vm');
});

test('R9 control-plane CAS fencing rejects duplicate work and resource conflicts',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'r9-fabric-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new EmbeddedControlPlaneStore(root);
  const fabric=new DistributedEngineeringFabric(store,{clock:()=>new Date(now)});
  const work=order();
  const placement=rankDistributedWorkers(work,[worker('worker-a')],now);
  const isolation=compileDistributedIsolation(work,placement);
  const lease=await fabric.acquire(work,placement,isolation);
  assert.equal(lease.epoch,1);
  await assert.rejects(()=>fabric.acquire(work,placement,isolation),(error:any)=>error?.code==='DISTRIBUTED_EXECUTION_DUPLICATE');

  const other=order({workUnitId:'implementation-2'});
  const otherPlacement=rankDistributedWorkers(other,[worker('worker-b')],now);
  const otherIsolation=compileDistributedIsolation(other,otherPlacement);
  await assert.rejects(()=>fabric.acquire(other,otherPlacement,otherIsolation),(error:any)=>error?.code==='DISTRIBUTED_RESOURCE_CONFLICT');
});

test('R9 result acceptance rejects stale fences and requires independent verification',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'r9-result-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new EmbeddedControlPlaneStore(root);
  const fabric=new DistributedEngineeringFabric(store,{clock:()=>new Date(now)});
  const work=order();
  const placement=rankDistributedWorkers(work,[worker('worker-a')],now);
  const isolation=compileDistributedIsolation(work,placement);
  const lease=await fabric.acquire(work,placement,isolation);
  const artifact=sha('artifact');
  const common={
    objectiveId:work.objectiveId,planId:work.planId,workUnitId:work.workUnitId,
    workerId:lease.workerId,deviceId:lease.deviceId,authorityDigest:lease.authorityDigest,
    leaseId:lease.leaseId,leaseEpoch:lease.epoch,isolationDigest:lease.isolationDigest,
    resourceKeys:work.resourceKeys,actionIds:['action-1'],evidenceIds:[sha('evidence')],
    artifactIds:[artifact],parentLineageDigests:[],outcome:'VERIFIED' as const
  };
  const stale=createDistributedLineage({...common,fenceToken:sha('wrong-fence'),verifierIds:['verifier-1']});
  await assert.rejects(()=>fabric.acceptResult({lineage:stale,artifactIds:[artifact]}),(error:any)=>error?.code==='DISTRIBUTED_STALE_RESULT');

  const selfVerified=createDistributedLineage({...common,fenceToken:lease.fenceToken,verifierIds:[lease.workerId]});
  await assert.rejects(()=>fabric.acceptResult({lineage:selfVerified,artifactIds:[artifact]}),(error:any)=>error?.code==='DISTRIBUTED_VERIFIER_NOT_INDEPENDENT');

  const verified=createDistributedLineage({...common,fenceToken:lease.fenceToken,verifierIds:['verifier-1']});
  const accepted=await fabric.acceptResult({lineage:verified,artifactIds:[artifact]});
  assert.equal(accepted.lineageDigest,verified.digest);
  assert.deepEqual((await fabric.result(work.objectiveId,work.workUnitId))?.artifactIds,[artifact]);
});

test('R9 expired leases can be fenced by a new epoch and old workers cannot commit',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'r9-epoch-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let clock=new Date(now);
  const store=new EmbeddedControlPlaneStore(root);
  const fabric=new DistributedEngineeringFabric(store,{clock:()=>clock});
  const work=order();
  const firstPlacement=rankDistributedWorkers(work,[worker('worker-a')],now);
  const firstIsolation=compileDistributedIsolation(work,firstPlacement);
  const first=await fabric.acquire(work,firstPlacement,firstIsolation);
  clock=new Date(Date.parse(now)+11_000);
  const secondNow=clock.toISOString();
  const secondPlacement=rankDistributedWorkers(work,[worker('worker-b',{observedAt:secondNow})],secondNow);
  const secondIsolation=compileDistributedIsolation(work,secondPlacement);
  const second=await fabric.acquire(work,secondPlacement,secondIsolation);
  assert.equal(second.epoch,2);
  assert.notEqual(second.fenceToken,first.fenceToken);

  const oldLineage=createDistributedLineage({
    objectiveId:work.objectiveId,planId:work.planId,workUnitId:work.workUnitId,
    workerId:first.workerId,deviceId:first.deviceId,authorityDigest:first.authorityDigest,
    leaseId:first.leaseId,leaseEpoch:first.epoch,fenceToken:first.fenceToken,isolationDigest:first.isolationDigest,
    resourceKeys:work.resourceKeys,actionIds:['old-action'],evidenceIds:[sha('old-evidence')],
    verifierIds:['verifier-1'],artifactIds:[sha('old-artifact')],parentLineageDigests:[],outcome:'VERIFIED'
  });
  await assert.rejects(()=>fabric.acceptResult({lineage:oldLineage,artifactIds:oldLineage.artifactIds}),(error:any)=>error?.code==='DISTRIBUTED_STALE_RESULT');
});

test('R9 distributed lineage is deterministic and causally complete',()=>{
  const input={
    objectiveId:'o',planId:'p',workUnitId:'w',workerId:'worker',deviceId:'device',
    authorityDigest:sha('authority'),leaseId:'lease',leaseEpoch:4,fenceToken:sha('fence'),isolationDigest:sha('isolation'),
    resourceKeys:['repo:a','repo:b'],actionIds:['a1','a2'],evidenceIds:[sha('e1')],
    verifierIds:['v1'],artifactIds:[sha('artifact')],parentLineageDigests:[sha('parent')],outcome:'VERIFIED' as const
  };
  const first=createDistributedLineage(input);
  const second=createDistributedLineage(input);
  assert.equal(first.digest,second.digest);
  assert.match(first.digest,/^[0-9a-f]{64}$/);
});
