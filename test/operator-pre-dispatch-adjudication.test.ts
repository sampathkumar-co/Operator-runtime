import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalActionExecutionStore } from '../apps/local-agent/src/action-execution-store.ts';
import { OperatorPreDispatchAdjudicator } from '../apps/local-agent/src/operator-pre-dispatch-adjudication.ts';
import { ActionTransitionJournal } from '../src/core/action-transition-journal.ts';
function signer() {
  const {publicKey,privateKey} = crypto.generateKeyPairSync('ed25519');
  const deviceId = '22222222-2222-4222-8222-222222222222';
  const fingerprint = 'a'.repeat(64);
  return {
    async loadExisting() { return { deviceId, fingerprint, deviceName:'test', createdAt:new Date(0).toISOString(), publicKeyPem:'' }; },
    async sign(payload: Uint8Array) { return crypto.sign(null,payload,privateKey).toString('base64url'); },
    async verify(payload: Uint8Array,signature:string) { return crypto.verify(null,payload,publicKey,Buffer.from(signature,'base64url')); }
  };
}
const action = {id:'mcp-legacy-policy-defer', capability:'app.operate', risk:'external' as const,
  input:{operation:'select',selector:{automationId:'tab',controlType:'TabItem'}},
  provenance:{kind:'chatgpt' as const}};
const denied=(e:any)=>['OPERATOR_RECOVERY_DENIED','ACTION_JOURNAL_PRE_DISPATCH_UNPROVEN'].includes(e?.code);
async function setup(t:test.TestContext,provider='policy') {
  const state=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-recovery-'));
  t.after(()=>fs.rm(state,{recursive:true,force:true}));
  await new LocalActionExecutionStore(state).begin(action);
  const journal=new ActionTransitionJournal(state);
  await journal.prepare({action,ownerKind:'local-api',ownerId:action.id,resourceKeys:['application:uia']});
  await journal.defer(action.id,{ok:false,capability:action.capability,provider,evidence:[],durationMs:0,
    error:{code:'APPROVAL_REQUIRED',message:'Approval needed',sideEffectState:'none',executionPhase:'pre_dispatch'}});
  const p=path.join(state,'action-executions.json');
  const data=JSON.parse(await fs.readFile(p,'utf8'));
  delete data.records[0].ownerProcess;
  await fs.writeFile(p,JSON.stringify(data));
  return {state,journal,identity:signer()};
}

test('operator signs exact policy deferral, terminally fences it, and replays decision idempotently',async t=>{
  const {state,journal,identity}=await setup(t);
  const op=new OperatorPreDispatchAdjudicator(state,{signer:identity});
  const c=await op.inspect(action.id);
  assert.equal(c.recoveryEpoch,1);
  await assert.rejects(op.adjudicate({actionId:action.id,caseDigest:c.caseDigest,confirmation:'yes',ownerAttestation:'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED'}),denied);
  const result=await op.adjudicate({actionId:action.id,caseDigest:c.caseDigest,confirmation:'AUTHORIZE-NO-REPLAY:'+c.caseDigest,ownerAttestation:'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED'});
  assert.equal(result.state,'INTERRUPTED');
  assert.deepEqual((await journal.inspect(action.id)).transitions.map(t=>t.state),['PREPARED','DEFERRED','INTERRUPTED']);
  await assert.rejects(journal.markDispatched(action.id,'late-provider'),(e:any)=>e?.code==='ACTION_JOURNAL_TRANSITION_INVALID');
  assert.deepEqual(await op.adjudicate({actionId:action.id,caseDigest:c.caseDigest,confirmation:'AUTHORIZE-NO-REPLAY:'+c.caseDigest,ownerAttestation:'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED'}),result);
  const ledger=JSON.parse(await fs.readFile(path.join(state,'operator-pre-dispatch-adjudications.json'),'utf8'));
  assert.equal(ledger.decisions.length,1);
  assert.equal(ledger.decisions[0].actionDigest,c.actionDigest);
});
test('a prior provider dispatch wins over stale operator case review',async t=>{
  const {state,journal,identity}=await setup(t);
  const op=new OperatorPreDispatchAdjudicator(state,{signer:identity});
  const c=await op.inspect(action.id);
  await journal.markDispatched(action.id,'real-provider');
  await assert.rejects(op.adjudicate({actionId:action.id,caseDigest:c.caseDigest,confirmation:'AUTHORIZE-NO-REPLAY:'+c.caseDigest,ownerAttestation:'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED'}),denied);
  assert.equal((await journal.inspect(action.id)).state,'DISPATCHED');
});
test('non-policy deferral cannot become operator recovery candidate',async t=>{
  const {state,identity}=await setup(t,'filesystem.native');
  await assert.rejects(new OperatorPreDispatchAdjudicator(state,{signer:identity}).inspect(action.id),denied);
});

test('operator recovery refuses process-bound receipt (including unbound Windows owner)',async t=>{
  const {state,identity}=await setup(t);
  const file=path.join(state,'action-executions.json');
  const data=JSON.parse(await fs.readFile(file,'utf8'));
  data.records[0].ownerProcess={pid:321,started:'windows-filetime:133444444444444444'};
  await fs.writeFile(file,JSON.stringify(data));
  await assert.rejects(new OperatorPreDispatchAdjudicator(state,{signer:identity}).inspect(action.id),denied);
});
test('operator signed history rejects tampering and a foreign signing identity',async t=>{
  const {state,identity}=await setup(t);
  const op=new OperatorPreDispatchAdjudicator(state,{signer:identity});
  const c=await op.inspect(action.id);
  await op.adjudicate({actionId:action.id,caseDigest:c.caseDigest,confirmation:'AUTHORIZE-NO-REPLAY:'+c.caseDigest,ownerAttestation:'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED'});
  await assert.rejects(new OperatorPreDispatchAdjudicator(state,{signer:signer()}).inspect(action.id),denied);
  const file=path.join(state,'operator-pre-dispatch-adjudications.json');
  const ledger=JSON.parse(await fs.readFile(file,'utf8'));
  ledger.decisions[0].receiptAuthorityHash='f'.repeat(64);
  await fs.writeFile(file,JSON.stringify(ledger));
  await assert.rejects(op.inspect(action.id),denied);
});
test('signed operator recovery versus provider dispatch has one winner under the journal lock',async t=>{
  const {state,journal,identity}=await setup(t);
  const op=new OperatorPreDispatchAdjudicator(state,{signer:identity});
  const c=await op.inspect(action.id);
  const results=await Promise.allSettled([
    op.adjudicate({actionId:action.id,caseDigest:c.caseDigest,confirmation:'AUTHORIZE-NO-REPLAY:'+c.caseDigest,ownerAttestation:'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED'}),
    new ActionTransitionJournal(state).markDispatched(action.id,'racing-provider')
  ]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.ok(['INTERRUPTED','DISPATCHED'].includes((await journal.inspect(action.id)).state));
});
