import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createSanitizedEvaluationTrace, persistSanitizedEvaluationTrace
} from '../scripts/c01-sanitized-stepwise-trace.mjs';

const h=(c:string)=>c.repeat(64);
const source='a'.repeat(40);
const run={
  id:'run-fixture-1', lane:'C',arm:'mecord',sourceCommit:source,
  scenarioId:'private-example-023',scenarioVersion:'v1',seed:0,
  model:'local-model',provider:'mecord',claimedSuccess:false,verifiedSuccess:false,
  failureStage:'verifier',
  runnerDigest:h('b'),modelConfigDigest:h('c'),environmentDigest:h('d'),
  independentOracleDigest:h('e'),resultEvidenceDigest:h('f'),
  latencyMs:150,costMicros:45,humanInterventions:0,unauthorizedEffects:0
};
const hidden={secret:'API_KEY_SUPERSECRET',path:'C:\\Users\\someone\\private',receipt:'PROTECTED_LEDGER_RECORD'};
function fixture(){
  return {
    sourceCommit:source,suiteDigest:h('9'),runId:run.id,
    record:{...run, originalReceipt:hidden.receipt,notes:hidden.secret},
    steps:[
      {sequence:1,phase:'OBSERVE',providerClass:'browser',actionOrdinal:1,
        result:'PASS',sideEffectState:'none',failureStage:'none',
        evidenceDigest:h('1'),durationMs:12.5,secret:hidden.secret},
      {sequence:2,phase:'DISPATCH',providerClass:'browser',actionOrdinal:1,
        result:'PASS',sideEffectState:'known',failureStage:'none',
        evidenceDigest:h('2'),durationMs:100,path:hidden.path},
      {sequence:3,phase:'VERIFY',providerClass:'browser',actionOrdinal:1,
        result:'FAIL',sideEffectState:'known',failureStage:'verifier',
        evidenceDigest:h('3'),durationMs:30,receipt:hidden.receipt}
    ]
  };
}
test('C01 produces stepwise allowlisted JSONL without ever copying raw prompts, paths or original receipts',()=>{
  const trace=createSanitizedEvaluationTrace(fixture());
  assert.equal(trace.stepCount,3);
  assert.equal(trace.releaseAuthorization,'NOT_GRANTED');
  const lines=trace.bytes.trimEnd().split('\n').map(v=>JSON.parse(v));
  assert.deepEqual(lines.map(v=>v.kind),['header','step','step','step','scorer']);
  assert.equal(lines[1].sequence,1);
  assert.equal(lines[1].durationMs,12.5);
  assert.equal(lines[4].campaignCoverage,'PARTIAL_UNVERIFIED');
  assert.equal(lines[4].physicalAcceptance,'NOT_VERIFIED');
  assert.equal(lines[4].verifiedSuccess,false);
  for(const secret of Object.values(hidden))assert.ok(!trace.bytes.includes(secret));
  assert.ok(!trace.bytes.includes(run.scenarioId));
  assert.ok(!trace.bytes.includes(run.id));
  assert.equal(trace.sha256,crypto.createHash('sha256').update(trace.bytes).digest('hex'));
});
test('C01 JSONL is first-write-only with SHA, never overwrites or retries the same evaluation identity',async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-c01-trace-'));
  t.after(async()=>fs.rm(folder,{recursive:true,force:true}));
  const input={...fixture(),dir:folder};
  const saved=await persistSanitizedEvaluationTrace(input);
  assert.equal(saved.stepCount,3);
  const content=await fs.readFile(path.join(folder,saved.filename),'utf8');
  assert.equal(crypto.createHash('sha256').update(content).digest('hex'),saved.sha256);
  await assert.rejects(persistSanitizedEvaluationTrace(input),
    (e:any)=>e.code==='EEXIST');
  assert.equal(await fs.readFile(path.join(folder,saved.filename),'utf8'),content);
});
test('C01 no new dispatch after a prior uncertain effect, even with apparently successful later observations',()=>{
 const a=fixture();
 a.steps[1].sideEffectState='uncertain';
 const later={...a.steps[1],sequence:4,phase:'DISPATCH',actionOrdinal:2};
 a.steps.push(later);
 assert.throws(()=>createSanitizedEvaluationTrace(a),/Uncertain prior side effect/);
});
test('C01 malformed optional fields, wrong run identity, nonsequential events and invented scopes fail closed',()=>{
 const inputs=[
  {...fixture(),sourceCommit:'1'.repeat(39)},
  {...fixture(),runId:'a-different-id'},
  {...fixture(),steps:[{...fixture().steps[0],sequence:999}]},
  {...fixture(),steps:[{...fixture().steps[0],phase:'DIRECT_CREDENTIAL_EXPORT'}]},
  {...fixture(),steps:[{...fixture().steps[0],result:'FAIL',failureStage:'none'}]},
  {...fixture(),steps:[{...fixture().steps[0],actionOrdinal:'private-id'}]},
  {...fixture(),steps:[{...fixture().steps[0],durationMs:Number.NaN}]},
  {...fixture(),steps:[]}
 ];
 for(const bad of inputs) assert.throws(()=>createSanitizedEvaluationTrace(bad),/C01_TRACE_INVALID/);
});
test('C01 source manifest never accepts arbitrary path, even when contents would otherwise be safe',async()=>{
  await assert.rejects(persistSanitizedEvaluationTrace({...fixture(),dir:'../relative'}),
    /Absolute owner-approved/);
});
test('C01 symlinked output directory cannot receive evaluation trace',async t=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-c01-root-'));
 t.after(async()=>fs.rm(folder,{recursive:true,force:true}));
 const real=path.join(folder,'real'),linked=path.join(folder,'linked');
 await fs.mkdir(real);
 try{await fs.symlink(real,linked,'dir');}
 catch(e){if(['EPERM','EACCES'].includes((e as NodeJS.ErrnoException).code??''))return t.skip('No symlink privilege');throw e;}
 await assert.rejects(persistSanitizedEvaluationTrace({...fixture(),dir:linked}),/not a symlink/);
});

test('C01 rejects coercible object digests before any protected data can enter JSONL',()=>{
  const poison = { toString(){ return h('a'); }, protectedReceipt:hidden.receipt, token:hidden.secret };
  const cases=[
    {...fixture(),sourceCommit:{toString(){return source;},protectedReceipt:hidden.receipt}},
    {...fixture(),suiteDigest:poison},
    {...fixture(),steps:[{...fixture().steps[0],evidenceDigest:poison}]}
  ];
  for(const bad of cases){
    assert.throws(()=>createSanitizedEvaluationTrace(bad),/C01_TRACE_INVALID/);
  }
});
