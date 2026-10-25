import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { DurableModelCallBudgetLedger } from '../src/core/durable-model-call-budget-ledger.ts';
import { BoundedModelGoalInference } from '../src/core/bounded-model-goal-inference.ts';

const limits = { maxCalls: 3, maxOutputTokens: 768, maxCostMicros: 2700 };
function claim() {
  return {callId: crypto.randomUUID(), modelId:'local-test-model',
    maxOutputTokens:256, maxCostMicros:900};
}
async function temp(t:TestContext):Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-model-budget-'));
  t.after(async () => await fs.rm(root, { recursive:true,force:true,maxRetries:5,retryDelay:50 }));
  return root;
}
function matching(code:string) {
  return (error:any) => error && error.code === code;
}

test('C05 actual model inference reserves and settles on durable filesystem before provider call', async t => {
  const root=await temp(t);
  const ledger = new DurableModelCallBudgetLedger(root, limits);
  const observed: string[] = [];
  const adapter = new BoundedModelGoalInference({
    modelId:'local-test-model',maxOutputTokens:256,maxCostMicros:900,timeoutMs:400,
    ledger, generator:{
      async generate({prompt}) {
        observed.push('model');
        assert.ok(prompt.includes('https://allowed.example'));
        const pre = await new DurableModelCallBudgetLedger(root,limits).inspect();
        assert.deepEqual([pre.calls,pre.outstanding,pre.tokensReserved,pre.costMicrosReserved], [1,1,256,900]);
        return {text:JSON.stringify({
          goal:{kind:'browser-navigation',url:'https://allowed.example/page'},
          successConditions:['Verify target location from fresh observed page']
        })};
      }
    }
  });
  const result=await adapter.propose({
    allowModelTransmission:true,
    scope:{objective:'Visit approved help',approvedBrowserOrigins:['https://allowed.example'],approvedRoots:[]}
  });
  assert.equal(result.executionStarted,false);
  assert.equal(result.proposal.goal.kind,'browser-navigation');
  assert.deepEqual(observed,['model']);
  assert.deepEqual(await new DurableModelCallBudgetLedger(root,limits).inspect(),{
    calls:1,tokensReserved:256,costMicrosReserved:900,
    outstanding:0,unknownSpend:0,remainingCalls:2,remainingTokens:512,remainingCostMicros:1800
  });
});
test('C05 model reservation survives new process object and uncertain calls never receive refunds', async t => {
  const root=await temp(t);
  const a=new DurableModelCallBudgetLedger(root,limits);
  const first=claim();
  const {reservationId}=await a.reserve(first);
  const second=new DurableModelCallBudgetLedger(root,limits);
  const pending=await second.inspect();
  assert.equal(pending.calls,1);
  assert.equal(pending.outstanding,1);
  await second.finalize({callId:first.callId,reservationId,outcome:'UNKNOWN_SPEND'});
  await a.finalize({callId:first.callId,reservationId,outcome:'UNKNOWN_SPEND'});
  assert.equal((await a.inspect()).remainingCostMicros,1800);
  assert.equal((await a.inspect()).unknownSpend,1);
  await assert.rejects(a.finalize({
    callId:first.callId,reservationId,outcome:'VALIDATED_PROPOSAL'
  }),matching('TASK_MODEL_BUDGET_SETTLEMENT_CONFLICT'));
  await assert.rejects(a.reserve(first),matching('TASK_MODEL_BUDGET_DUPLICATE'));
});
test('C05 independent concurrent ledgers do not exceed exact owner call/token/cost caps', async t => {
  const root=await temp(t);
  const results=await Promise.allSettled(Array.from({length:12},()=>
    new DurableModelCallBudgetLedger(root,limits).reserve(claim())));
  const successes=results.filter(r=>r.status==='fulfilled');
  const failures=results.filter(r=>r.status==='rejected');
  assert.equal(successes.length,3);
  assert.equal(failures.length,9);
  assert.ok(failures.every(r=>r.status==='rejected'&&
    (r.reason?.code==='TASK_MODEL_BUDGET_EXHAUSTED')));
  const after=await new DurableModelCallBudgetLedger(root,limits).inspect();
  assert.deepEqual([after.calls,after.tokensReserved,after.costMicrosReserved,after.outstanding],[
    3,768,2700,3
  ]);
});
test('C05 corrupted, duplicate or changed-profile records fail closed rather than resetting',async t=>{
  const root=await temp(t);
  const a=new DurableModelCallBudgetLedger(root,limits);
  const first=claim();
  await a.reserve(first);
  await assert.rejects(
    new DurableModelCallBudgetLedger(root,{...limits,maxCostMicros:3000}).reserve(claim()),
    (error:any) => ['TASK_MODEL_BUDGET_PROFILE_CHANGED','TASK_MODEL_BUDGET_LEDGER_CORRUPT']
      .includes(error?.code)
  );
  const file=path.join(root,'model-budget','ledger-v1.json');
  const valid=JSON.parse(await fs.readFile(file,'utf8'));
  await fs.writeFile(file,JSON.stringify({...valid,reservations:[valid.reservations[0],valid.reservations[0]]}));
  await assert.rejects(a.inspect(),matching('TASK_MODEL_BUDGET_LEDGER_CORRUPT'));
  await fs.writeFile(file,'{"nonsense":true}');
  await assert.rejects(a.reserve(claim()),matching('TASK_MODEL_BUDGET_LEDGER_CORRUPT'));
  await fs.writeFile(file,'not json');
  await assert.rejects(a.inspect(),matching('TASK_MODEL_BUDGET_LEDGER_CORRUPT'));
});
test('C05 denied caps, forged reservations and symlinked state directory fail closed',async t=>{
  const root=await temp(t);
  assert.throws(()=>new DurableModelCallBudgetLedger('relative-path',limits),
    matching('TASK_MODEL_BUDGET_CONFIG_INVALID'));
  assert.throws(()=>new DurableModelCallBudgetLedger(root,{...limits,maxCalls:0}),
    matching('TASK_MODEL_BUDGET_CONFIG_INVALID'));
  const ledger=new DurableModelCallBudgetLedger(root,limits);
  await assert.rejects(ledger.reserve({...claim(),callId:'not-uuid'}),
    matching('TASK_MODEL_BUDGET_RESERVATION_INVALID'));
  await assert.rejects(ledger.finalize({
    reservationId:crypto.randomUUID(),callId:crypto.randomUUID(),outcome:'VALIDATED_PROPOSAL'
  }),matching('TASK_MODEL_BUDGET_UNKNOWN_RESERVATION'));
  const other=await temp(t);
  await fs.rm(path.join(root,'model-budget'),{recursive:true,force:true});
  try {
    await fs.symlink(other,path.join(root,'model-budget'),'dir');
  } catch(error) {
    if(['EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code??''))return t.skip('Host disallows symlinks');
    throw error;
  }
  await assert.rejects(ledger.reserve(claim()),matching('TASK_MODEL_BUDGET_LEDGER_CORRUPT'));
});


test('C05 deleting or replacing only the used ledger never silently replenishes model credits',async t=>{
  const root=await temp(t);
  const ledger=new DurableModelCallBudgetLedger(root,limits);
  await ledger.reserve(claim());
  const folder=path.join(root,'model-budget');
  const ledgerFile=path.join(folder,'ledger-v1.json');
  const markerFile=path.join(folder,'initialized-v1.json');
  assert.equal((await ledger.inspect()).remainingCalls,2);
  await fs.rm(ledgerFile);
  await assert.rejects(ledger.reserve(claim()),matching('TASK_MODEL_BUDGET_LEDGER_CORRUPT'));
  await assert.rejects(ledger.inspect(),matching('TASK_MODEL_BUDGET_LEDGER_CORRUPT'));
  await fs.writeFile(ledgerFile,JSON.stringify({
    schemaVersion:1,limits,reservations:[]
  }));
  await fs.writeFile(markerFile,JSON.stringify({
    schemaVersion:1,profileDigest:'a'.repeat(64)
  }));
  await assert.rejects(ledger.inspect(),matching('TASK_MODEL_BUDGET_LEDGER_CORRUPT'));
});
