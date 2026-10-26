import assert from 'node:assert/strict';
import test from 'node:test';
import { runPairedLaneC } from '../scripts/c01-paired-lane-c.mjs';

const d = (c:string)=>c.repeat(64);
const initial=d('a'),oracle=d('b'),model=d('c'),runner=d('d'),env=d('e');
const source='f'.repeat(40);
const scenario = {
  id:'checkout-demo-v1',version:'v1',seed:2,
  objective:'Complete a preapproved synthetic localhost checkout',
  prompt:'Complete the fixed checkout according to the approved page state',
  initialStateDigest:initial,independentOracleDigest:oracle
};
function setup() {
 const events:string[]=[];
 const cfg={
   sourceCommit:source,runnerDigest:runner,modelConfigDigest:model,
   environmentDigest:env,modelId:'same-local-model',
   maxOutputTokens:256,maxSteps:10,maxCostMicrosPerArm:1500,deadlineMs:500,
   cases:[scenario],
   async resetFixture({arm}:{arm:string}){
     events.push('reset:'+arm);return {initialStateDigest:initial};
   },
   async runArm({arm,promptDigest,modelConfigDigest,scenario,budget}:any){
     events.push('run:'+arm);
     assert.equal(scenario.initialStateDigest,undefined,'oracle hidden from actual task runner');
     assert.equal(scenario.independentOracleDigest,undefined,'oracle hidden from actual task runner');
     assert.equal(budget.maxCostMicros,1500);
     return {
       observedPromptDigest:promptDigest,
       observedModelConfigDigest:modelConfigDigest,
       claimedSuccess:true,humanInterventions:0,
       costMicros:200,
       evidence:{externalTaskReceipt:'separately-verified-in-fixture'}
     };
   },
   async verifyIndependentOutcome({arm,expectedOracleDigest}:any){
     events.push('oracle:'+arm);
     assert.equal(expectedOracleDigest,oracle);
     return {verifiedSuccess:true,independentOracleDigest:oracle,
       resultEvidenceDigest:d('1'),unauthorizedEffects:0,failureStage:'none'};
   }
 };
 return {cfg,events};
}
test('C01 Lane C matches model, prompt, environment, exact budget and independently verified outcomes', async()=>{
 const {cfg,events}=setup();
 const result=await runPairedLaneC(cfg);
 assert.deepEqual(events,[
   'reset:mecord','run:mecord','oracle:mecord',
   'reset:direct','run:direct','oracle:direct'
 ]);
 assert.equal(result.exactPairCount,1);
 assert.equal(result.status,'PARTIAL');
 assert.deepEqual(result.report.lanes.C.evidence.mecord.verifiedSuccesses,1);
 assert.deepEqual(result.report.lanes.C.evidence.direct.verifiedSuccesses,1);
 assert.equal(result.report.lanes.C.evidence.mecord.modelAndToolCostMicros,200);
 assert.equal(result.report.lanes.A.status,'NOT_RUN');
 assert.equal(result.report.lanes.B.status,'NOT_RUN');
 assert.equal(result.releaseAcceptance,'NOT_ACCEPTED');
 assert.equal(result.claimedPhysicalAcceptance,'NOT_VERIFIED');
});
test('C01 Lane C external oracle, not provider success claim, determines false completion',async()=>{
 const {cfg}=setup();
 cfg.verifyIndependentOutcome=async({arm}:any)=>({
   verifiedSuccess:arm==='direct',
   independentOracleDigest:oracle,resultEvidenceDigest:d('2'),
   unauthorizedEffects:0,
   failureStage:arm==='direct'?'none':'verifier'
 });
 const r=await runPairedLaneC(cfg);
 assert.equal(r.report.lanes.C.evidence.mecord.falseCompletions,1);
 assert.equal(r.report.lanes.C.evidence.mecord.verifiedSuccesses,0);
 assert.equal(r.report.lanes.C.evidence.direct.verifiedSuccesses,1);
});
test('C01 Lane C alternates direct/Mecord order by seed to limit order bias',async()=>{
 const {cfg,events}=setup();
 cfg.cases=[{...scenario,seed:3}];
 await runPairedLaneC(cfg);
 assert.equal(events[0],'reset:direct');
 assert.equal(events[3],'reset:mecord');
});
test('C01 Lane C refuses different fixture start before invoking second arm',async()=>{
 const {cfg,events}=setup();
 cfg.resetFixture=async({arm}:any)=>{
   events.push('reset:'+arm);
   return {initialStateDigest:arm==='direct'?d('9'):initial};
 };
 await assert.rejects(runPairedLaneC(cfg),/Fixture reset.*identical pre-action state/);
 assert.equal(events.includes('run:direct'),false);
});
test('C01 Lane C refuses mismatched prompt or model identity, even if claimed success',async()=>{
 const {cfg}=setup();
 cfg.runArm=async({arm,promptDigest,modelConfigDigest}:any)=>({
   claimedSuccess:true,observedPromptDigest:arm==='direct'?d('8'):promptDigest,
   observedModelConfigDigest:modelConfigDigest,humanInterventions:0,costMicros:5
 });
 await assert.rejects(runPairedLaneC(cfg),/Runner evidence failed exact model, prompt, cost or outcome contract/);
});
test('C01 Lane C fail closed on forged or missing independent outcome attestation',async()=>{
 const {cfg}=setup();
 cfg.verifyIndependentOutcome=async()=>({
   verifiedSuccess:true,independentOracleDigest:d('9'),resultEvidenceDigest:d('2'),
   unauthorizedEffects:0,failureStage:'none'
 });
 await assert.rejects(runPairedLaneC(cfg),/Fresh external outcome.*absent, stale or malformed/);
});
test('C01 Lane C timeout on even one arm quarantines comparison instead of resuming other arm',async()=>{
 const {cfg,events}=setup();
 cfg.deadlineMs=100;
 let release!:()=>void;
 const delay=new Promise<void>(resolve=>{release=resolve;});
 cfg.runArm=async({arm}:any)=>{
   events.push('run:'+arm);
   await delay;
   return {claimedSuccess:true};
 };
 await assert.rejects(runPairedLaneC(cfg),/TIMEOUT_UNKNOWN_EFFECT/);
 assert.deepEqual(events,['reset:mecord','run:mecord']);
 release();
});
test('C01 Lane C never treats unknown model spending as zero when bounded estimate exists',async()=>{
 const {cfg}=setup();
 cfg.runArm=async({promptDigest,modelConfigDigest}:any)=>({
   claimedSuccess:true,observedPromptDigest:promptDigest,
   observedModelConfigDigest:modelConfigDigest,
   humanInterventions:0
 });
 const r=await runPairedLaneC(cfg);
 assert.equal(r.report.lanes.C.evidence.mecord.modelAndToolCostMicros,1500);
 assert.equal(r.report.lanes.C.evidence.direct.modelAndToolCostMicros,1500);
});
test('C01 Lane C rejects duplicated or malformed paired cases before running',async()=>{
 const {cfg,events}=setup();
 cfg.cases=[scenario,scenario];
 await assert.rejects(runPairedLaneC(cfg),/Duplicate scenario/);
 assert.deepEqual(events,[]);
 cfg.cases=[{...scenario,prompt:'\0secret'}];
 await assert.rejects(runPairedLaneC(cfg),/source-pinned model/);
});


test('C01 rejects coercible numeric scenario IDs before reset or external tool effects',async()=>{
  const {cfg,events}=setup();
  cfg.cases=[{...scenario,id:12 as never}];
  await assert.rejects(runPairedLaneC(cfg),/source-pinned model/);
  assert.deepEqual(events,[]);
  cfg.cases=[{...scenario,version:23 as never}];
  await assert.rejects(runPairedLaneC(cfg),/source-pinned model/);
  assert.deepEqual(events,[]);
});

test('C01 Lane C bounds independent fixture reset and never dispatches if reset stalls',async()=>{
  const {cfg,events}=setup();
  cfg.deadlineMs=100;
  let release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  cfg.resetFixture=async({arm}:any)=>{
    events.push('reset:'+arm);
    await blocked;
    return {initialStateDigest:initial};
  };
  try {
    await assert.rejects(runPairedLaneC(cfg),/RESET_TIMEOUT_UNKNOWN_EFFECT/);
    assert.deepEqual(events,['reset:mecord']);
  }finally{release();}
});

test('C01 Lane C bounds stalled independent oracle and refuses the second arm',async()=>{
  const {cfg,events}=setup();
  cfg.deadlineMs=100;
  let release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  cfg.verifyIndependentOutcome=async({arm}:any)=>{
    events.push('oracle:'+arm);
    await blocked;
    return {verifiedSuccess:true,independentOracleDigest:oracle,
      resultEvidenceDigest:d('1'),unauthorizedEffects:0,failureStage:'none'};
  };
  try {
    await assert.rejects(runPairedLaneC(cfg),/ORACLE_TIMEOUT_UNKNOWN_EFFECT/);
    assert.deepEqual(events,[
      'reset:mecord','run:mecord','oracle:mecord'
    ]);
  }finally{release();}
});

test('C01 Lane C rejects failed reset and failed independent oracle without continuing',async()=>{
  const {cfg,events}=setup();
  cfg.resetFixture=async({arm}:any)=>{
    events.push('reset:'+arm);
    throw new Error('raw sensitive fixture detail');
  };
  await assert.rejects(runPairedLaneC(cfg),/RESET_FAILED_UNKNOWN_EFFECT/);
  assert.deepEqual(events,['reset:mecord']);

  const other=setup();
  other.cfg.verifyIndependentOutcome=async({arm}:any)=>{
    other.events.push('oracle:'+arm);
    throw new Error('raw sensitive oracle detail');
  };
  await assert.rejects(runPairedLaneC(other.cfg),/ORACLE_FAILED_UNKNOWN_EFFECT/);
  assert.deepEqual(other.events,['reset:mecord','run:mecord','oracle:mecord']);
});
