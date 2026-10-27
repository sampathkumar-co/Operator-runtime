import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildOriginalRecoveryReviewModel } from '../src/core/original-recovery-ux.ts';
import { LocalActionExecutionStore } from '../apps/local-agent/src/action-execution-store.ts';
import { ActionTransitionJournal } from '../src/core/action-transition-journal.ts';
import type { ActionRequest } from '../src/core/types.ts';

const at = '2026-10-27T00:00:00.000Z';
function receipt(id: string, risk = 'write', extra: Record<string, unknown> = {}) {
  return { actionId: id, actionHash: 'a'.repeat(64), authorityHash: 'secret-approval-authority',
    status: 'processing', risk, startedAt: at,
    ownerProcess: { marker: 'SENSITIVE_PROCESS_CREATION_TIME' },
    ...extra } as any;
}
function journal(id: string, states = ['PREPARED'], extra: Record<string, unknown> = {}) {
  return { actionId: id, actionDigest: 'a'.repeat(64), version: 1,
    ownerKind: 'SENSITIVE_OWNER', ownerId: 'SENSITIVE_OWNER_ID', capability: 'file.create',
    risk: 'write', generation: 1, state: states.at(-1),
    resourceKeys: ['SENSITIVE_RESOURCE_SCOPE'],
    transitions: states.map((state, index) => ({
      seq: index + 1, state, at, provider: 'SENSITIVE_PROVIDER'
    })), createdAt: at, updatedAt: at, ...extra } as any;
}

test('C08 review projection reports PREPARED without granting website approval', () => {
  const model = buildOriginalRecoveryReviewModel([receipt('a-1')],[journal('a-1')]);
  assert.equal(model.items.length, 1);
  assert.equal(model.items[0]!.status, 'REVIEW_REQUIRED');
  assert.equal(model.items[0]!.ownerVerificationRequired, true);
  assert.equal(model.items[0]!.canApproveOnWebsite, false);
  assert.equal(model.websiteApprovalAvailable, false);
  assert.equal(model.counts.REVIEW_REQUIRED, 1);
});

test('C08 strict PREPARED to INTERRUPTED lineage remains gated on independent reconciliation', () => {
  const model = buildOriginalRecoveryReviewModel(
    [receipt('a-1')],[journal('a-1',['PREPARED','INTERRUPTED'])]);
  assert.equal(model.items[0]!.status, 'FENCED_AWAITING_RECONCILIATION');
  assert.equal(model.items[0]!.ownerVerificationRequired, true);
  for(const states of [
    ['PREPARED','DISPATCHED','INTERRUPTED'],
    ['PREPARED','OBSERVED','INTERRUPTED'],
    ['PREPARED','DEFERRED','INTERRUPTED']
  ]) {
    const result = buildOriginalRecoveryReviewModel([receipt('a-1')],[journal('a-1',states)]);
    assert.notEqual(result.items[0]!.status, 'FENCED_AWAITING_RECONCILIATION');
  }
});

test('C08 dispatched outcomes, duplicate journals and forged matching metadata never become safe', () => {
  assert.equal(buildOriginalRecoveryReviewModel(
    [receipt('a-1')],[journal('a-1',['PREPARED','DISPATCHED'])])
    .items[0]!.status,'OUTCOME_UNCERTAIN');
  const duplicate = buildOriginalRecoveryReviewModel(
    [receipt('a-1')],[journal('a-1'),journal('a-1')]);
  assert.equal(duplicate.items[0]!.status, 'AUTHORITY_REVIEW_REQUIRED');
  assert.equal(buildOriginalRecoveryReviewModel(
    [receipt('a-1')],[journal('a-1',['PREPARED','INTERRUPTED'],{ actionDigest:'wrong' })])
    .items[0]!.status,'AUTHORITY_REVIEW_REQUIRED');
  assert.equal(buildOriginalRecoveryReviewModel(
    [receipt('a-1')],[journal('a-1',['PREPARED','INTERRUPTED'],{ generation: 2 })])
    .items[0]!.status,'REVIEW_REQUIRED');
});

test('C08 review output excludes sensitive payload and owner authority material', () => {
  const r = receipt('a-1','write', {result:{payload:'SENSITIVE_RESULT'}});
  const j = journal('a-1',['PREPARED','DISPATCHED'],{
    actionDigest: 'a'.repeat(64),
    resourceKeys:['/SENSITIVE_RESOURCE'], ownerId:'SENSITIVE_OWNER', intent:{secret:'SENSITIVE_GRANT'}
  });
  const model = buildOriginalRecoveryReviewModel([r],[j]);
  const text = JSON.stringify(model);
  for (const forbidden of [
    'SENSITIVE_RESULT','SENSITIVE_PROCESS_CREATION_TIME','secret-approval-authority',
    'SENSITIVE_RESOURCE','SENSITIVE_OWNER','SENSITIVE_GRANT','authorityHash','ownerProcess'
  ]) assert.equal(text.includes(forbidden), false, forbidden);
});

test('C08 duplicate pending receipts or invalid IDs fail closed rather than hide risk', () => {
  assert.throws(() => buildOriginalRecoveryReviewModel(
    [receipt('a-1'),receipt('a-1')],[]),
    (e: any) => e?.code === 'ORIGINAL_RECOVERY_REVIEW_INVALID');
  assert.throws(() => buildOriginalRecoveryReviewModel(
    [receipt('unsafe\nid')],[]),
    (e: any) => e?.code === 'ORIGINAL_RECOVERY_REVIEW_INVALID');
  assert.throws(() => buildOriginalRecoveryReviewModel(
    Array.from({length:257},(_,i)=>receipt('id-'+i)),[]),
    (e: any) => e?.code === 'ORIGINAL_RECOVERY_REVIEW_INVALID');
});

test('C08 original pending receipt query is bounded and cannot modify durable state', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-recovery-metadata-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new LocalActionExecutionStore(root);
  const action:ActionRequest={id:crypto.randomUUID(),capability:'file.create',risk:'write',
    input:{path:'/private/path-not-for-ui.txt',content:'SENSITIVE_CONTENT'},provenance:{kind:'chatgpt'}};
  await store.begin(action);
  const journalStore=new ActionTransitionJournal(root);
  await journalStore.prepare({action,ownerKind:'task',ownerId:'recovery-test',resourceKeys:['file:test']});
  const filenames=['action-executions.json','action-transitions.json'];
  const before=await Promise.all(filenames.map(name=>fs.readFile(path.join(root,name),'utf8')));
  const pending=await store.listOperatorPendingReceipts();
  const journalEntries=await journalStore.list(100);
  assert.equal(pending.length,1);
  const model=buildOriginalRecoveryReviewModel(pending,journalEntries);
  assert.equal(model.items[0]!.status,'REVIEW_REQUIRED');
  const output=JSON.stringify(model);
  assert.equal(output.includes('SENSITIVE_CONTENT'),false);
  assert.equal(output.includes('/private/path-not-for-ui.txt'),false);
  for(const limit of [0,-1,257,1.5,NaN]) {
    await assert.rejects(()=>store.listOperatorPendingReceipts(limit),
      (e: any)=>e?.code==='ACTION_EXECUTION_ACTION_MISMATCH');
  }
  const after=await Promise.all(filenames.map(name=>fs.readFile(path.join(root,name),'utf8')));
  assert.deepEqual(after,before);
});



test('C08 reviewed action reference is not the caller-controlled action ID, path or credential text', () => {
  const privateIdentifier = 'project/secrets/CREDENTIAL-LIKE-TOKEN:owner-private-task';
  const original=receipt(privateIdentifier,'write');
  const paired=journal(privateIdentifier,['PREPARED']);
  const first=buildOriginalRecoveryReviewModel([original],[paired]);
  const second=buildOriginalRecoveryReviewModel([original],[paired]);
  assert.equal(first.items.length,1);
  assert.match(first.items[0]!.actionId,/^review:[a-f0-9]{64}$/);
  assert.equal(first.items[0]!.actionId,second.items[0]!.actionId);
  assert.notEqual(first.items[0]!.actionId,privateIdentifier);
  for(const leaked of ['project/secrets','CREDENTIAL-LIKE-TOKEN','owner-private-task']) {
    assert.equal(JSON.stringify(first).includes(leaked),false,leaked);
  }
  assert.notEqual(buildOriginalRecoveryReviewModel([
    receipt('different-action-id','write')
  ],[journal('different-action-id')]).items[0]!.actionId,first.items[0]!.actionId);
});

test('C08 stored timestamp cannot copy free-form date text into a recovery API', () => {
  const r=receipt('safe-id','write',{startedAt:'Tue, 27 Oct 2026 00:00:00 GMT'});
  const model=buildOriginalRecoveryReviewModel([r],[journal('safe-id')]);
  assert.equal(model.items[0]!.startedAt,'2026-10-27T00:00:00.000Z');
  assert.equal(JSON.stringify(model).includes('GMT'),false);
});
