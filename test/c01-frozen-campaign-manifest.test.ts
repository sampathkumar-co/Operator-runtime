import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFrozen125CampaignManifest } from '../scripts/c01-frozen-campaign-manifest.mjs';
import { buildWave0EvaluationReport } from '../scripts/wave0-evaluation.mjs';
const h=(c:string,n=64)=>c.repeat(n);
const source=h('a',40);
const fixture=()=>({
  sourceCommit:source,dataset:{name:'miniwob',
    revision:h('b',40),taskIds:Array.from({length:125},(_,i)=>
      'task_'+String(i+1).padStart(3,'0')),
    fixtureBuildDigest:h('c'),independentOracleDigest:h('d')},
  seeds:[0,42,2026],models:[{name:'local-model',version:'model-v1',
    configDigest:h('e'),promptDigest:h('f')}],
  budget:{maxSteps:25,maxModelCalls:5,maxTokensPerCall:256,
    maxCostMicros:100_000,maxWallTimeMs:30_000},
  runnerDigest:h('1'),environmentDigest:h('2')
});
test('C01 source preregistration binds 125 exact task identities, seeds, model, prompt and budgets',()=>{
  const first=validateFrozen125CampaignManifest(fixture());
  const next=validateFrozen125CampaignManifest(fixture());
  assert.deepEqual(first,next,'manifest digest stable for matching revision');
  assert.equal(first.taskCount,125);
  assert.equal(first.seedCount,3);
  assert.equal(first.sourceContract,'PREREGISTERED_ONLY');
  assert.equal(first.historicalMiniWob102of125,'UNREPRODUCIBLE_NOT_COUNTED');
  assert.equal(first.releaseAcceptance,'NOT_ACCEPTED');
  const report=buildWave0EvaluationReport({
    sourceCommit:source,preregistered:first.preregistered
  });
  assert.equal(report.suite.scenarios,125);
  assert.equal(report.suite.expectedRunsPerLane,375);
  assert.deepEqual(['A','B','C'].map(lane=>report.lanes[lane].status),
    ['NOT_RUN','NOT_RUN','NOT_RUN']);
  assert.equal(report.releaseAcceptance,'NOT_ACCEPTED');
});
test('C01 changing model, budget, fixture or dataset changes preregistration digest',()=>{
  const base=validateFrozen125CampaignManifest(fixture()).manifestDigest;
  for(const mutate of [
    (x:any)=>{x.models[0].version='model-v2';},
    (x:any)=>{x.budget.maxSteps++;},
    (x:any)=>{x.dataset.fixtureBuildDigest=h('9');},
    (x:any)=>{x.dataset.taskIds.reverse();}
  ]){
    const x=fixture();mutate(x);
    assert.notEqual(validateFrozen125CampaignManifest(x).manifestDigest,base);
  }
});
test('C01 manifest refuses incomplete, duplicate, sparse and getter-backed campaign specifications',()=>{
  let invoked=0;
  const attacks=[
    (x:any)=>{x.dataset.taskIds.pop();},
    (x:any)=>{x.dataset.taskIds[1]=x.dataset.taskIds[0];},
    (x:any)=>{x.dataset.revision='floating-main';},
    (x:any)=>{x.seeds=[0,42,42];},
    (x:any)=>{x.models=[{...x.models[0],name:'scripted'}];},
    (x:any)=>{x.budget.maxCostMicros=-1;},
    (x:any)=>{x.dataset.taskIds=Array(125);},
    (x:any)=>{Object.defineProperty(x.models[0],'promptDigest',{
      enumerable:true,get(){invoked++;return h('f');}});},
    (x:any)=>{Object.defineProperty(x.budget,'maxSteps',{
      enumerable:true,get(){invoked++;return 25;}});},
    (x:any)=>{Object.defineProperty(x,'sourceCommit',{
      enumerable:true,get(){invoked++;return source;}});}
  ];
  for(const mutate of attacks){
    const x=fixture();mutate(x);
    assert.throws(()=>validateFrozen125CampaignManifest(x),/C01_CAMPAIGN_MANIFEST_INVALID/);
  }
  assert.equal(invoked,0,'no accessor-backed campaign fields may execute');
});

test('C01 frozen dataset revision must be a literal commit, not an executable identity',()=>{
  let conversions=0;
  const manifest=fixture();
  manifest.dataset.revision={toString(){conversions++;return 'b'.repeat(40);}} as never;
  assert.throws(()=>validateFrozen125CampaignManifest(manifest),
    /C01_CAMPAIGN_MANIFEST_INVALID/);
  assert.equal(conversions,0);
});

test('C01 task manifest rejects names which its own report cannot score',()=>{
  for(const id of ['folder/task_001','namespace:task_001']){
    const input=fixture();
    input.dataset.taskIds[0]=id;
    assert.throws(()=>validateFrozen125CampaignManifest(input),
      /C01_CAMPAIGN_MANIFEST_INVALID/);
  }
});

test('C01 evaluation report refuses sparse or getter-backed records before scoring coverage',()=>{
  const blank=Array(2);
  assert.throws(()=>buildWave0EvaluationReport({sourceCommit:source,records:blank}),
    /WAVE0_EVALUATION_INVALID/);
  let invoked=0;
  const bad:any[]=[];
  Object.defineProperty(bad,'0',{enumerable:true,get(){invoked++;return {};}});bad.length=1;
  assert.throws(()=>buildWave0EvaluationReport({sourceCommit:source,records:bad}),
    /WAVE0_EVALUATION_INVALID/);
  assert.equal(invoked,0);
  const c=validateFrozen125CampaignManifest(fixture());
  c.preregistered.expectedSeeds[2]=undefined as never;
  assert.throws(()=>buildWave0EvaluationReport({sourceCommit:source,
    preregistered:c.preregistered}),/WAVE0_EVALUATION_INVALID/);
});
