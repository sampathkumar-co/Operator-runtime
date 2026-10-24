import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/core/action-identity.ts';
import { certifyOriginalReceipts } from '../scripts/certify-original-receipt-disposition.mjs';

const digest=(o: unknown) => crypto.createHash('sha256').update(canonicalJson(o)).digest('hex');
const fixtureJson=(o: unknown) => JSON.stringify(o);

test('original receipt disposition verifies exact signed journal history, terminal fence and immutable fixture state', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-signed-recovery-audit-'));
  t.after(async () => fs.rm(root,{recursive:true,force:true}));
  const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
  const pem=publicKey.export({type:'spki',format:'pem'}).toString();
  const deviceId=crypto.randomUUID();
  const fingerprint=crypto.createHash('sha256').update(pem).digest('base64url');
  const actionId='fixture-no-replay-mutation';
  const readId='fixture-read-only';
  const actionHash=digest('fixture-original-action');
  const authorityHash=digest('fixture-authority');
  const ownerId=crypto.randomUUID();
  const ownerProcess={pid:1000,started:'windows-filetime:133500000000000000'};
  const terminalDigest=digest({actionId,actionDigest:actionHash,kind:'pre_dispatch_interrupted'});
  const before=[{seq:1,state:'PREPARED',at:'2026-10-24T03:00:00.000Z'}];
  const terminal={seq:2,state:'INTERRUPTED',at:'2026-10-24T03:02:00.000Z',
     provider:'agent-kernel',resultDigest:terminalDigest};
  const partialDecision={
    version:1,epoch:1,actionId,actionDigest:actionHash,
    receiptAuthorityHash:authorityHash,receiptOwnerId:ownerId,
    receiptOwnerProcessDigest:digest(ownerProcess),
    journalGeneration:1,transitionsDigest:digest(before),
    deviceId,deviceFingerprint:fingerprint
  };
  const decisionUnsigned={
    version:1,epoch:1,actionId,actionDigest:actionHash,
    receiptAuthorityHash:authorityHash,receiptOwnerId:ownerId,
    receiptOwnerProcessDigest:digest(ownerProcess),
    caseDigest:digest({
      actionId,actionDigest:actionHash,
      receiptAuthorityHash:authorityHash,receiptOwnerId:ownerId,
      receiptOwnerProcessDigest:digest(ownerProcess),
      journalGeneration:1,transitionsDigest:digest(before),
      recoveryEpoch:1,deviceId,deviceFingerprint:fingerprint
    }),
    journalGeneration:1,transitionsDigest:digest(before),deviceId,deviceFingerprint:fingerprint,
    previousDigest:'0'.repeat(64),adjudicatedAt:'2026-10-24T03:01:00.000Z',
    operatorAttestation:'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED'
  };
  const decision={...decisionUnsigned,signature:
      crypto.sign(null,Buffer.from(canonicalJson(decisionUnsigned)),privateKey).toString('base64url')};

  const initial: Record<string,any>={
    'device-identity.json':{version:2,deviceId,publicKeyPem:pem},
    'action-executions.json':{version:1,records:[
      {actionId,actionHash,authorityHash,ownerId,ownerProcess,risk:'write',status:'processing'},
      {actionId:readId,actionHash:digest('read'),authorityHash:digest('read-authority'),
       ownerId:crypto.randomUUID(),risk:'read',status:'processing'}]},
    'action-transitions.json':{version:1,entries:[
      {version:1,actionId,actionDigest:actionHash,generation:1,state:'INTERRUPTED',
       risk:'write',transitions:[...before,terminal]}]},
    'operator-pre-dispatch-adjudications.json':{version:1,decisions:[decision]},
    'relay-client.json':{version:1,lastAckedServerSeq:3568}
  };
  const write=async(n:string,v:unknown)=>fs.writeFile(path.join(root,n),fixtureJson(v));
  for(const [n,v] of Object.entries(initial)) await write(n,v);
  const snapshots=await Promise.all(Object.keys(initial).map(n=>fs.readFile(path.join(root,n))));
  const report=await certifyOriginalReceipts(root);
  assert.equal(report.processingReceipts,2);
  assert.equal(report.verifiedLedgerDecisions,1);
  assert.equal(report.summary.SIGNED_TERMINAL_NO_REPLAY_RETAIN_RECEIPT,1);
  assert.equal(report.summary.READ_ONLY_RECEIPT_NO_JOURNAL_RETAIN_UNRESOLVED,1);
  assert.equal(report.unsupported,0);
  assert.equal(report.canDeleteReceipts,false);
  assert.equal(report.canReplayMutations,false);
  assert.equal(JSON.stringify(report).includes(actionId),false);
  for(const [i,n] of Object.keys(initial).entries()) assert.deepEqual(await fs.readFile(path.join(root,n)),snapshots[i]);

  async function expectHeld(name:string, mutate:(f:Record<string,any>)=>void) {
    const state=structuredClone(initial);
    mutate(state);
    for(const [n,v] of Object.entries(state)) await write(n,v);
    const actual=await certifyOriginalReceipts(root);
    assert.ok(actual.unsupported >= 1, name+' must not be classified as valid no-replay evidence');
    assert.equal(actual.releaseDisposition,'HOLD_EVIDENCE_INCOMPLETE');
  }
  await expectHeld('Tampered original PREPARED transition',f=>{
    f['action-transitions.json'].entries[0].transitions[0].at='2026-10-24T02:59:00.000Z';
  });
  await expectHeld('Injected middle transition',f=>{
    f['action-transitions.json'].entries[0].transitions.splice(1,0,
      {seq:2,state:'DISPATCHED',at:'2026-10-24T03:01:30.000Z'});
  });
  await expectHeld('Changed terminal journal proof',f=>{
    f['action-transitions.json'].entries[0].transitions[1].resultDigest=digest('other-result');
  });
  await expectHeld('Changed original Windows process authority',f=>{
    f['action-executions.json'].records[0].ownerProcess.pid=1001;
  });
  await expectHeld('Changed original receipt authorization hash',f=>{
    f['action-executions.json'].records[0].authorityHash=digest('wrong');
  });
  await expectHeld('Duplicate pending receipt identity',f=>{
    f['action-executions.json'].records.push({...f['action-executions.json'].records[0],ownerId:crypto.randomUUID()});
  });

  const absent=structuredClone(initial);
  absent['action-executions.json'].records=absent['action-executions.json'].records.filter((r:any)=>r.actionId!==actionId);
  for(const [n,v] of Object.entries(absent)) await write(n,v);
  const orphan=await certifyOriginalReceipts(root);
  assert.equal(orphan.historicalSignedWithoutReceiptCount,1,
    'A signed no-replay decision with no corresponding receipt must be disclosed');
  assert.equal(orphan.historicalSignedWithoutReceipt[0].signedJournalPrefixMatches,true);
  assert.equal(orphan.releaseDisposition,'HOLD_EVIDENCE_INCOMPLETE');
  assert.equal(orphan.processingReceipts,1);
  assert.equal(orphan.unsupported,0);

  for(const [n,v] of Object.entries(initial)) await write(n,v);
  const tampered=structuredClone(initial['operator-pre-dispatch-adjudications.json']);
  tampered.decisions[0].signature='AAAA'+tampered.decisions[0].signature.slice(4);
  await write('operator-pre-dispatch-adjudications.json',tampered);
  await assert.rejects(certifyOriginalReceipts(root),/DEVICE_SIGNATURE_INVALID/);

  for(const [n,v] of Object.entries(initial)) await write(n,v);
  const alteredCase=structuredClone(initial['operator-pre-dispatch-adjudications.json']);
  alteredCase.decisions[0].caseDigest=digest('unrelated-case');
  const {signature,...unsigned}=alteredCase.decisions[0];
  alteredCase.decisions[0].signature=crypto.sign(null,Buffer.from(canonicalJson(unsigned)),privateKey).toString('base64url');
  await write('operator-pre-dispatch-adjudications.json',alteredCase);
  assert.equal((await certifyOriginalReceipts(root)).unsupported,1,'A valid signature over an unrelated case digest cannot certify original intent');
});
