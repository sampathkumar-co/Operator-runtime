import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';
import { LocalActionExecutionStore } from '../apps/local-agent/src/action-execution-store.ts';
import { ActionTransitionJournal } from '../src/core/action-transition-journal.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import type { ActionRequest } from '../src/core/types.ts';

test('C08 original recovery GET is local-bearer only, bounded and never authorizes replay', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'operator-recovery-local-api-'));
  t.after(async()=>fs.rm(root,{recursive:true,force:true}));
  const receipts=new LocalActionExecutionStore(root);
  const journal=new ActionTransitionJournal(root);
  const action:ActionRequest={
    id:crypto.randomUUID(),capability:'file.create',risk:'write',
    input:{path:path.join(root,'SENSITIVE_ACTION_FILE.txt'),content:'SENSITIVE_PAYLOAD_BYTES'},
    provenance:{kind:'chatgpt'}
  };
  await receipts.begin(action);
  await journal.prepare({action,ownerKind:'task',ownerId:'SENSITIVE_OWNER_ID',resourceKeys:['SENSITIVE_RESOURCE_KEY']});
  const bearer='b'.repeat(64);
  const runtime=new OperatorRuntime();
  const local=createLocalAgentServer({
    runtime,token:bearer,
    permissions:{allowedCapabilities:['file.create'],allowedRoots:[root],
      allowDestructive:false,allowExternalWrites:false,allowSystemChanges:false},
    actionExecutions:receipts,agentKernel:{journal} as any
  });
  t.after(async()=>{await local.close();await runtime.close();});
  const bound=await local.listen('127.0.0.1',0);
  const base='http://127.0.0.1:'+bound.port+'/v1/control-center/original-recovery';

  const untrusted=await fetch(base);
  assert.equal(untrusted.status,401);
  const headers={authorization:'Bearer '+bearer};
  const read=await fetch(base,{headers});
  assert.equal(read.status,200);
  const payload=await read.json() as any;
  assert.equal(payload.ok,true);
  assert.equal(payload.model.items.length,1);
  assert.equal(payload.model.items[0].status,'REVIEW_REQUIRED');
  assert.equal(payload.model.websiteApprovalAvailable,false);
  assert.equal(payload.model.items[0].ownerVerificationRequired,true);
  assert.equal(payload.model.items[0].canApproveOnWebsite,false);
  const text=JSON.stringify(payload);
  for(const forbidden of [
    'SENSITIVE_ACTION_FILE','SENSITIVE_PAYLOAD','SENSITIVE_OWNER','SENSITIVE_RESOURCE',
    'actionHash','authorityHash','ownerProcess','resultDigest','resourceKeys'
  ]) assert.equal(text.includes(forbidden),false,forbidden);

  for(const limit of ['0','201','nan','1.5','-1','1000000']) {
    const response=await fetch(base+'?limit='+encodeURIComponent(limit),{headers});
    assert.equal(response.status,400);
  }
  const relayMarked=await fetch(base,{headers:{...headers,'x-operator-relay-request':'1'}});
  assert.ok(relayMarked.status===403 || relayMarked.status===400);
  const badPost=await fetch(base+'/'+encodeURIComponent(action.id)+'/adjudicate',{
    method:'POST',headers:{...headers,'content-type':'application/json'},
    body:JSON.stringify({ownerAttestation:'FAKE',confirmation:'AUTHORIZE-NO-REPLAY'})
  });
  assert.notEqual(badPost.status,200);
  assert.notEqual(badPost.status,202);
  const stillPending=await receipts.listOperatorPendingReceipts();
  assert.equal(stillPending.length,1);
  assert.equal((await journal.inspect(action.id))?.state,'PREPARED');
  await assert.rejects(fs.access(path.join(root,'SENSITIVE_ACTION_FILE.txt')));
});

test('C08 original recovery endpoint refuses availability without local journal and receipts', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'operator-recovery-api-not-configured-'));
  t.after(async()=>fs.rm(root,{recursive:true,force:true}));
  const runtime=new OperatorRuntime();
  const bearer='b'.repeat(64);
  const local=createLocalAgentServer({
    runtime,token:bearer,
    permissions:{allowedCapabilities:[],allowedRoots:[root],
      allowDestructive:false,allowExternalWrites:false,allowSystemChanges:false}
  });
  t.after(async()=>{await local.close();await runtime.close();});
  const bound=await local.listen('127.0.0.1',0);
  const response=await fetch('http://127.0.0.1:'+bound.port+'/v1/control-center/original-recovery',{
    headers:{authorization:'Bearer '+bearer}
  });
  assert.equal(response.status,503);
  assert.equal(((await response.json()) as any).error.code,'ORIGINAL_RECOVERY_REVIEW_NOT_CONFIGURED');
});
