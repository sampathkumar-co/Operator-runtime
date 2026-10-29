import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalActionExecutionStore } from '../apps/local-agent/src/action-execution-store.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';
import { OperatorPreDispatchAdjudicator } from '../apps/local-agent/src/operator-pre-dispatch-adjudication.ts';
import { ActionTransitionJournal } from '../src/core/action-transition-journal.ts';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
async function signer(state: string) {
  // Test-only reversible protector makes a real existing identity without
  // depending on physical Windows secrets or provisioning new identities.
  const secretProtector = {
    scheme: 'windows-dpapi-current-user' as const,
    async protect(b:Buffer) { return Buffer.from(b); },
    async unprotect(b:Buffer) { return Buffer.from(b); }
  };
  const identity=new DeviceIdentityStore(state,{secretProtector});
  await identity.loadOrCreate('operator-test-device');
  return identity;
}
function foreignSigner() {
  return {
    async loadExisting() { return {deviceId:'33333333-3333-4333-8333-333333333333',
      fingerprint:'foreign',deviceName:'foreign',createdAt:new Date(0).toISOString(),publicKeyPem:''}; },
    async sign() { throw new Error('foreign signer unavailable'); },
    async verify() { return false; }
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
  return {state,journal,identity:await signer(state)};
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
  // The relay's original action envelope can reconcile a negative, no-effect
  // receipt after the signed journal fence without invoking any provider.
  const repaired = await new LocalActionExecutionStore(state).reconcileWithKernel(action,undefined,journal);
  assert.equal(repaired.status,'completed');
  if (repaired.status === 'completed') {
    assert.equal(repaired.result.ok,false);
    assert.equal(repaired.result.error?.sideEffectState,'none');
    assert.equal(repaired.result.error?.code,'ACTION_EXECUTION_INTERRUPTED_BEFORE_DISPATCH');
  }
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

test('operator recovery refuses malformed or unsupported process-bound receipt',async t=>{
  const {state,identity}=await setup(t);
  const file=path.join(state,'action-executions.json');
  const data=JSON.parse(await fs.readFile(file,'utf8'));
  data.records[0].ownerProcess={pid:321,started:'unsupported-host-identity'};
  await fs.writeFile(file,JSON.stringify(data));
  await assert.rejects(new OperatorPreDispatchAdjudicator(state,{signer:identity}).inspect(action.id),denied);
});
test('operator signed history rejects tampering and a foreign signing identity',async t=>{
  const {state,identity}=await setup(t);
  const op=new OperatorPreDispatchAdjudicator(state,{signer:identity});
  const c=await op.inspect(action.id);
  await op.adjudicate({actionId:action.id,caseDigest:c.caseDigest,confirmation:'AUTHORIZE-NO-REPLAY:'+c.caseDigest,ownerAttestation:'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED'});
  await assert.rejects(new OperatorPreDispatchAdjudicator(state,{signer:foreignSigner()}).inspect(action.id),denied);
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

test('direct journal operator recovery without a prior signed ledger is forbidden',async t=>{
  const {state,journal,identity}=await setup(t);
  const c=await new OperatorPreDispatchAdjudicator(state,{signer:identity}).inspect(action.id);
  await assert.rejects(journal.interruptOperatorReviewedPolicyDeferral({
    actionId:action.id,actionDigest:c.actionDigest,
    generation:c.journalGeneration,transitionsDigest:c.transitionsDigest
  }),(e:any)=>e?.code==='OPERATOR_RECOVERY_PROOF_REQUIRED');
  assert.equal((await journal.inspect(action.id)).state,'DEFERRED');
});

test('signed operator fence repairs relay HTTP receipt and refuses identical action replay',async t=>{
  const {state,journal,identity}=await setup(t);
  const op=new OperatorPreDispatchAdjudicator(state,{signer:identity});
  const c=await op.inspect(action.id);
  await op.adjudicate({actionId:action.id,caseDigest:c.caseDigest,
    confirmation:'AUTHORIZE-NO-REPLAY:'+c.caseDigest,
    ownerAttestation:'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED'});
  let dispatches=0;
  const agent=createLocalAgentServer({
    token:'x'.repeat(64),
    permissions:{allowedCapabilities:['app.inspect','app.operate'],allowedRoots:[]},
    runtime:{async execute(){dispatches++;throw new Error('provider must not run');}} as any,
    agentKernel:{journal,async execute(){dispatches++;throw new Error('kernel must not dispatch');}} as any,
    actionExecutions:new LocalActionExecutionStore(state)
  });
  t.after(()=>agent.close());
  const bound=await agent.listen('127.0.0.1',0);
  const invoke=(endpoint:string)=>fetch('http://127.0.0.1:'+bound.port+endpoint,{
    method:'POST',
    headers:{authorization:'Bearer '+'x'.repeat(64),'content-type':'application/json'},
    body:JSON.stringify({action})
  });
  const recovered=await invoke('/v1/action-receipt');
  assert.equal(recovered.status,200);
  const body=await recovered.json() as any;
  assert.equal(body.receipt.status,'completed');
  assert.equal(body.result.error.code,'ACTION_EXECUTION_INTERRUPTED_BEFORE_DISPATCH');
  assert.equal(body.result.error.sideEffectState,'none');
  const duplicate=await invoke('/v1/execute');
  assert.equal(duplicate.status,409);
  assert.equal((await duplicate.json() as any).error.code,'ACTION_EXECUTION_INTERRUPTED_BEFORE_DISPATCH');
  assert.equal(dispatches,0);
});

test('journal refuses a signed operator decision if legacy receipt authority changes before fence',async t=>{
  const {state,journal,identity}=await setup(t);
  const before=JSON.parse(await fs.readFile(path.join(state,'action-transitions.json'),'utf8'));
  const op=new OperatorPreDispatchAdjudicator(state,{signer:identity});
  const c=await op.inspect(action.id);
  await op.adjudicate({
    actionId:action.id,caseDigest:c.caseDigest,confirmation:'AUTHORIZE-NO-REPLAY:'+c.caseDigest,
    ownerAttestation:'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED'
  });
  // Fault-injection fixture: restore journal only to its original pre-dispatch
  // transition sequence while keeping the legitimate signed operator proof.
  await fs.writeFile(path.join(state,'action-transitions.json'),JSON.stringify(before));
  const file=path.join(state,'action-executions.json');
  const receipts=JSON.parse(await fs.readFile(file,'utf8'));
  receipts.records[0].authorityHash='f'.repeat(64);
  await fs.writeFile(file,JSON.stringify(receipts));
  await assert.rejects(journal.interruptOperatorReviewedPolicyDeferral({
    actionId:action.id,actionDigest:c.actionDigest,generation:1,transitionsDigest:c.transitionsDigest
  }),(e:any)=>e?.code==='OPERATOR_RECOVERY_PROOF_INVALID');
  assert.equal((await journal.inspect(action.id)).state,'DEFERRED');
});

test('Windows original-device operator review fences an exited process-bound approval without dispatch',async t=>{
  if(process.platform!=='win32') {t.skip('Windows process identity and host proof');return;}
  const {state,journal,identity}=await setup(t);
  const file=path.join(state,'action-executions.json');
  const data=JSON.parse(await fs.readFile(file,'utf8'));
  data.records[0].ownerProcess={pid:2_000_000_000,started:'windows-filetime:134361639345200387'};
  await fs.writeFile(file,JSON.stringify(data));
  const op=new OperatorPreDispatchAdjudicator(state,{signer:identity});
  const c=await op.inspect(action.id);
  assert.match(c.receiptOwnerProcessDigest??'',/^[a-f0-9]{64}$/);
  const result=await op.adjudicate({actionId:action.id,caseDigest:c.caseDigest,
    confirmation:'AUTHORIZE-NO-REPLAY:'+c.caseDigest,
    ownerAttestation:'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED'});
  assert.equal(result.state,'INTERRUPTED');
  const ledger=JSON.parse(await fs.readFile(path.join(state,'operator-pre-dispatch-adjudications.json'),'utf8'));
  assert.equal(ledger.decisions[0].receiptOwnerProcessDigest,c.receiptOwnerProcessDigest);
  assert.deepEqual((await journal.inspect(action.id)).transitions.map(t=>t.state),['PREPARED','DEFERRED','INTERRUPTED']);
  const repaired=await new LocalActionExecutionStore(state).reconcileWithKernel(action,undefined,journal);
  assert.equal(repaired.status,'completed');
  if(repaired.status==='completed')assert.equal(repaired.result.error?.sideEffectState,'none');
  await assert.rejects(journal.markDispatched(action.id,'late-provider'),(e:any)=>e?.code==='ACTION_JOURNAL_TRANSITION_INVALID');
});

test('Windows signed process-bound operator proof cannot fence a changed owner identity',async t=>{
  if(process.platform!=='win32') {t.skip('Windows process identity and host proof');return;}
  const {state,journal,identity}=await setup(t);
  const receiptsFile=path.join(state,'action-executions.json');
  const receipt=JSON.parse(await fs.readFile(receiptsFile,'utf8'));
  receipt.records[0].ownerProcess={pid:2_000_000_000,started:'windows-filetime:134361639345200387'};
  await fs.writeFile(receiptsFile,JSON.stringify(receipt));
  const journalFile=path.join(state,'action-transitions.json');
  const before=await fs.readFile(journalFile,'utf8');
  const op=new OperatorPreDispatchAdjudicator(state,{signer:identity});
  const c=await op.inspect(action.id);
  await op.adjudicate({actionId:action.id,caseDigest:c.caseDigest,
    confirmation:'AUTHORIZE-NO-REPLAY:'+c.caseDigest,
    ownerAttestation:'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED'});
  // Crash/restore fixture: journal write from before fence, signed proof retained.
  // A different durable process identity must not inherit the signed intent.
  await fs.writeFile(journalFile,before);
  receipt.records[0].ownerProcess.started='windows-filetime:134361639345200388';
  await fs.writeFile(receiptsFile,JSON.stringify(receipt));
  await assert.rejects(journal.interruptOperatorReviewedPolicyDeferral({
    actionId:action.id,actionDigest:c.actionDigest,generation:1,transitionsDigest:c.transitionsDigest
  }),(e:any)=>e?.code==='OPERATOR_RECOVERY_PROOF_INVALID');
  assert.equal((await journal.inspect(action.id)).state,'DEFERRED');
});


const preparedWriteAction = {
  id: 'mcp-original-prepared-browser-write',
  capability: 'browser.navigate',
  risk: 'write' as const,
  input: { url: 'https://example.org/recovery-test' },
  provenance: { kind: 'chatgpt' as const }
};
async function setupPreparedWrite(t: test.TestContext, withOwnerProcess = true) {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-prepared-write-recovery-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  await new LocalActionExecutionStore(state).begin(preparedWriteAction);
  const journal = new ActionTransitionJournal(state);
  await journal.prepare({
    action: preparedWriteAction,
    ownerKind: 'local-api',
    ownerId: preparedWriteAction.id,
    resourceKeys: ['browser:global']
  });
  const file = path.join(state, 'action-executions.json');
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  if (withOwnerProcess) {
    // Deliberately impossible Windows PID: no live user process is touched.
    data.records[0].ownerProcess = { pid: 2_000_000_000, started: 'windows-filetime:134361639345200387' };
  } else {
    delete data.records[0].ownerProcess;
  }
  await fs.writeFile(file, JSON.stringify(data));
  return { state, journal, identity: await signer(state) };
}

test('prepared write requires signed original-device review and fences browser navigation without dispatch', async t => {
  if (process.platform !== 'win32') { t.skip('Windows process identity and original-host attestation'); return; }
  const { state, journal, identity } = await setupPreparedWrite(t);
  const op = new OperatorPreDispatchAdjudicator(state, { signer: identity });
  const c = await op.inspect(preparedWriteAction.id);
  await assert.rejects(op.adjudicate({
    actionId: c.actionId, caseDigest: c.caseDigest, confirmation: 'yes',
    ownerAttestation: 'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED'
  }), denied);
  const result = await op.adjudicate({
    actionId: c.actionId, caseDigest: c.caseDigest,
    confirmation: 'AUTHORIZE-NO-REPLAY:' + c.caseDigest,
    ownerAttestation: 'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED'
  });
  assert.equal(result.state, 'INTERRUPTED');
  assert.deepEqual((await journal.inspect(preparedWriteAction.id)).transitions.map(x => x.state),
    ['PREPARED', 'INTERRUPTED']);
  const repaired = await new LocalActionExecutionStore(state).reconcileWithKernel(
    preparedWriteAction, undefined, journal
  );
  assert.equal(repaired.status, 'completed');
  if (repaired.status === 'completed') {
    assert.equal(repaired.result.ok, false);
    assert.equal(repaired.result.error?.code, 'ACTION_EXECUTION_INTERRUPTED_BEFORE_DISPATCH');
    assert.equal(repaired.result.error?.sideEffectState, 'none');
  }
  await assert.rejects(journal.markDispatched(preparedWriteAction.id, 'late-browser-provider'),
    (e: any) => e?.code === 'ACTION_JOURNAL_TRANSITION_INVALID');
});

test('unbound prepared write cannot be operator-recovered by inferring no dispatch from journal alone', async t => {
  const { state, identity } = await setupPreparedWrite(t, false);
  await assert.rejects(
    new OperatorPreDispatchAdjudicator(state, { signer: identity }).inspect(preparedWriteAction.id), denied
  );
});

test('already dispatched browser write is never a prepared-write recovery candidate', async t => {
  const { state, journal, identity } = await setupPreparedWrite(t);
  await journal.markDispatched(preparedWriteAction.id, 'browser');
  await assert.rejects(
    new OperatorPreDispatchAdjudicator(state, { signer: identity }).inspect(preparedWriteAction.id), denied
  );
});


test('signed pre-dispatch journal fence finishes the exact pending receipt without replay and remains permanent', async t => {
  const { state, journal, identity } = await setup(t);
  const adjudicator = new OperatorPreDispatchAdjudicator(state, { signer: identity });
  const proof = await adjudicator.inspect(action.id);
  await adjudicator.adjudicate({
    actionId: action.id, caseDigest: proof.caseDigest,
    confirmation: 'AUTHORIZE-NO-REPLAY:' + proof.caseDigest,
    ownerAttestation: 'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED'
  });
  assert.equal((await journal.inspect(action.id)).state, 'INTERRUPTED');
  const receipts = new LocalActionExecutionStore(state);
  assert.equal((await receipts.inspectOperatorReceipt(action.id))?.status, 'processing');
  const verified = await adjudicator.inspectSignedFence(action.id);
  assert.equal(verified.caseDigest, proof.caseDigest);
  assert.equal(verified.risk, 'external');
  await assert.rejects(adjudicator.finalizeSignedFenceReceipt(action.id, '0'.repeat(64)),
    /changed before reconciliation/);
  assert.equal((await receipts.inspectOperatorReceipt(action.id))?.status, 'processing');
  const result = await adjudicator.finalizeSignedFenceReceipt(action.id, verified.caseDigest);
  assert.equal(result.status, 'RECEIPT_RECONCILED');
  const completed = await receipts.inspectOperatorReceipt(action.id);
  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.result?.ok, false);
  assert.equal(completed?.result?.error?.code, 'ACTION_EXECUTION_INTERRUPTED_BEFORE_DISPATCH');
  assert.equal(completed?.result?.evidence?.[0]?.kind, 'signed_operator_fence');
  assert.equal((await journal.inspect(action.id)).state, 'INTERRUPTED');
  const fresh = new LocalActionExecutionStore(state, {
    clock: () => new Date(Date.now() + 400 * 24 * 3600_000)
  });
  assert.equal((await fresh.begin(action)).status, 'completed',
    'a signed no-replay receipt cannot expire and be started again after ordinary retention');
  assert.equal((await fresh.inspectOperatorReceipt(action.id))?.status, 'completed');
});

test('signed fence reconciliation never accepts changed authority, unsigned decisions or a dispatched journal', async t => {
  const { state, journal, identity } = await setup(t);
  const adjudicator = new OperatorPreDispatchAdjudicator(state, { signer: identity });
  await assert.rejects(adjudicator.inspectSignedFence(action.id));
  const c = await adjudicator.inspect(action.id);
  await adjudicator.adjudicate({
    actionId: action.id, caseDigest: c.caseDigest,
    confirmation: 'AUTHORIZE-NO-REPLAY:' + c.caseDigest,
    ownerAttestation: 'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED'
  });
  const p = path.join(state, 'action-executions.json');
  const before = JSON.parse(await fs.readFile(p, 'utf8'));
  const corrupted = structuredClone(before);
  corrupted.records[0].authorityHash = '0'.repeat(64);
  await fs.writeFile(p, JSON.stringify(corrupted));
  await assert.rejects(adjudicator.inspectSignedFence(action.id));
  await assert.rejects(adjudicator.finalizeSignedFenceReceipt(action.id, c.caseDigest));
  const still = JSON.parse(await fs.readFile(p, 'utf8'));
  assert.equal(still.records[0].status, 'processing');
  assert.equal((await journal.inspect(action.id)).state, 'INTERRUPTED');
});

test('Control Center signed-fence finalization requires a separate owner confirmation', async t => {
  const { state, journal, identity } = await setup(t);
  const adjudicator = new OperatorPreDispatchAdjudicator(state, { signer: identity });
  const c = await adjudicator.inspect(action.id);
  await adjudicator.adjudicate({
    actionId: action.id, caseDigest: c.caseDigest,
    confirmation: 'AUTHORIZE-NO-REPLAY:' + c.caseDigest,
    ownerAttestation: 'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED'
  });
  const { buildOriginalRecoveryReviewModel } = await import('../src/core/original-recovery-ux.ts');
  const receipts = new LocalActionExecutionStore(state);
  const model = buildOriginalRecoveryReviewModel(
    await receipts.listOperatorPendingReceipts(200), await journal.list(1000)
  );
  const item = model.items[0]!;
  assert.equal(item.status, 'FENCED_AWAITING_RECONCILIATION');
  const { OriginalRecoveryOwnerResolution } = await import('../apps/local-agent/src/operator-pre-dispatch-adjudication.ts');
  const denied = new OriginalRecoveryOwnerResolution(state, {
    adjudicator, confirmOwner: async () => false
  });
  await assert.rejects(denied.resolve(item.actionId));
  assert.equal((await receipts.inspectOperatorReceipt(action.id))?.status, 'processing');
  const owner = new OriginalRecoveryOwnerResolution(state, {
    adjudicator, confirmOwner: async input => {
      assert.equal(input.caseDigest, c.caseDigest);
      assert.equal(input.risk, 'external');
      assert.equal(input.mode, 'reconcile');
      return true;
    }
  });
  const result = await owner.resolve(item.actionId);
  assert.equal(result.status, 'RECEIPT_RECONCILED');
  assert.equal((await receipts.inspectOperatorReceipt(action.id))?.status, 'completed');
  assert.equal((await journal.inspect(action.id)).state, 'INTERRUPTED');
});


test('already device-signed destructive PREPARED fence can reconcile receipt without granting new destructive approval', async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-existing-destructive-fence-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const { canonicalJson } = await import('../src/core/action-identity.ts');
  const crypto = await import('node:crypto');
  const sha = (value: unknown) => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
  const oldAction = {
    id: 'mecord-old-destructive-fence-fixture', capability: 'terminal.execute',
    risk: 'destructive' as const, input: { command: 'DO_NOT_EXECUTE' },
    provenance: { kind: 'chatgpt' as const }
  };
  const receipts = new LocalActionExecutionStore(state);
  await receipts.begin(oldAction);
  const journal = new ActionTransitionJournal(state);
  await journal.prepare({ action: oldAction, ownerKind: 'local-api', ownerId: oldAction.id, resourceKeys: [] });
  const before = await journal.inspect(oldAction.id);
  const receipt = await receipts.inspectOperatorReceipt(oldAction.id);
  const identity = await signer(state);
  const device = await identity.loadExisting();
  assert.ok(device && receipt);
  const original = {
    actionId: oldAction.id, actionDigest: before.actionDigest,
    receiptAuthorityHash: receipt!.authorityHash, receiptOwnerId: receipt!.ownerId!,
    receiptOwnerProcessDigest: sha(receipt!.ownerProcess), journalGeneration: 1,
    transitionsDigest: sha(before.transitions), recoveryEpoch: 1,
    deviceId: device!.deviceId, deviceFingerprint: device!.fingerprint
  };
  const caseDigest = sha(original);
  const unsigned = {
    version: 1 as const, epoch: 1, actionId: oldAction.id,
    actionDigest: before.actionDigest, receiptAuthorityHash: receipt!.authorityHash,
    receiptOwnerId: receipt!.ownerId!,
    receiptOwnerProcessDigest: original.receiptOwnerProcessDigest,
    caseDigest, journalGeneration: 1,
    transitionsDigest: original.transitionsDigest,
    deviceId: device!.deviceId, deviceFingerprint: device!.fingerprint,
    previousDigest: '0'.repeat(64), adjudicatedAt: new Date().toISOString(),
    operatorAttestation: 'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED'
  };
  const signature = await identity.sign(Buffer.from(canonicalJson(unsigned)));
  await fs.writeFile(path.join(state, 'operator-pre-dispatch-adjudications.json'),
    JSON.stringify({ version: 1, decisions: [{ ...unsigned, signature }] }));
  await journal.interruptPreparedBeforeDispatch(oldAction);
  const safe = new OperatorPreDispatchAdjudicator(state, { signer: identity });
  const verified = await safe.inspectSignedFence(oldAction.id);
  assert.equal(verified.risk, 'destructive');
  assert.equal(verified.caseDigest, caseDigest);
  const result = await safe.finalizeSignedFenceReceipt(oldAction.id, caseDigest);
  assert.equal(result.status, 'RECEIPT_RECONCILED');
  assert.equal((await receipts.inspectOperatorReceipt(oldAction.id))?.result?.error?.code,
    'ACTION_EXECUTION_INTERRUPTED_BEFORE_DISPATCH');
  assert.equal((await journal.inspect(oldAction.id)).state, 'INTERRUPTED');
  assert.equal((await receipts.begin(oldAction)).status, 'completed');
  // A fresh unsigned destructive PREPARED case is NOT eligible for adjudication.
  const unsignedAction = { ...oldAction, id: oldAction.id + '-unsigned' };
  await receipts.begin(unsignedAction);
  await journal.prepare({ action: unsignedAction, ownerKind: 'local-api', ownerId: unsignedAction.id, resourceKeys: [] });
  await assert.rejects(safe.inspectSignedFence(unsignedAction.id));
  await assert.rejects(safe.finalizeSignedFenceReceipt(unsignedAction.id, caseDigest));
  assert.equal((await receipts.inspectOperatorReceipt(unsignedAction.id))?.status, 'processing');
});
