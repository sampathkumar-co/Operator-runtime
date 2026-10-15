import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';
import { LocalActionExecutionStore } from '../apps/local-agent/src/action-execution-store.ts';
import { ActionTransitionJournal } from '../src/core/action-transition-journal.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { buildOriginalRecoveryReviewModel } from '../src/core/original-recovery-ux.ts';
import type { ActionRequest } from '../src/core/types.ts';

const prepared: ActionRequest={id:'original-prepared-web-test',capability:'browser.navigate',risk:'write',
  input:{url:'https://secret.example/private'},provenance:{kind:'chatgpt'}};
const readAction: ActionRequest={id:'original-read-web-test',capability:'computer.inspect',risk:'read',
  input:{},provenance:{kind:'chatgpt'}};

test('original recovery website lists only metadata; bearer cannot sign or reconcile',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-recovery-ui-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const receipts=new LocalActionExecutionStore(root);
  const journal=new ActionTransitionJournal(root);
  await receipts.begin(prepared);
  await journal.prepare({action:prepared,ownerKind:'test',ownerId:'review',resourceKeys:['application:browser']});
  await receipts.begin(readAction);
  const runtime=createRuntime({allowedRoots:[root],allowedExecutables:['node']});
  const agent=createLocalAgentServer({runtime,token:'t'.repeat(64),permissions:{allowedCapabilities:['browser.navigate','computer.inspect'],allowedRoots:[root]},
    actionExecutions:receipts,agentKernel:{journal} as any});
  t.after(async()=>{await agent.close();await runtime.close()});
  const bound=await agent.listen('127.0.0.1',0);
  const endpoint='http://127.0.0.1:'+bound.port+'/v1/control-center/original-recovery';
  assert.equal((await fetch(endpoint)).status,401);
  const headers={authorization:'Bearer '+'t'.repeat(64)};
  const pending=await fetch(endpoint,{headers});
  assert.equal(pending.status,200);
  const body=await pending.json() as any;
  assert.equal(body.configured,true);
  assert.equal(body.model.items.length,2);
  assert.equal(body.model.items.find((x:any)=>x.actionId===prepared.id).status,'REVIEW_REQUIRED');
  assert.equal(body.model.items.find((x:any)=>x.actionId===readAction.id).status,'AUTHORITY_REVIEW_REQUIRED');
  assert.equal(body.model.websiteApprovalAvailable,false);
  assert.equal(body.model.items.every((x:any)=>x.canApproveOnWebsite===false),true);
  const text=JSON.stringify(body);
  for(const forbidden of ['secret.example','authorityHash','ownerProcess','privateKey','actionHash','receiptOwnerId','approvalAuthority'])
    assert.equal(text.includes(forbidden),false,forbidden+' must never leak');
  const before=await Promise.all(['action-executions.json','action-transitions.json'].map(x=>fs.readFile(path.join(root,x),'utf8')));
  const attempt=await fetch(endpoint+'/'+encodeURIComponent(prepared.id)+'/adjudicate',{
    method:'POST',headers:{...headers,'content-type':'application/json'},
    body:JSON.stringify({confirmation:'AUTHORIZE-NO-REPLAY:fake',ownerAttestation:'fake'})
  });
  assert.equal(attempt.status,403);
  assert.equal((await attempt.json() as any).error.code,'OWNER_STEP_UP_NOT_CONFIGURED');
  const after=await Promise.all(['action-executions.json','action-transitions.json'].map(x=>fs.readFile(path.join(root,x),'utf8')));
  assert.deepEqual(after,before);
});

test('read-only UI projection rejects duplicate receipts and distinguishes uncertain dispatch',()=>{
  const receipt:any={actionId:prepared.id,actionHash:'hash',authorityHash:'secret',status:'processing',risk:'write',startedAt:'2026-10-15T00:00:00Z'};
  const journal:any={actionId:prepared.id,actionDigest:'hash',risk:'write',capability:'browser.navigate',generation:1,
    state:'DISPATCHED',transitions:[{state:'PREPARED'},{state:'DISPATCHED'}]};
  assert.equal(buildOriginalRecoveryReviewModel([receipt],[journal]).items[0]!.status,'OUTCOME_UNCERTAIN');
  assert.throws(()=>buildOriginalRecoveryReviewModel([receipt,receipt],[journal]),/Duplicate recovery receipts/);
  journal.state='INTERRUPTED'; journal.transitions=[{state:'PREPARED'},{state:'INTERRUPTED'}];
  assert.equal(buildOriginalRecoveryReviewModel([receipt],[journal]).items[0]!.status,'FENCED_AWAITING_RECONCILIATION');
  journal.transitions=[{state:'PREPARED'},{state:'DISPATCHED'},{state:'INTERRUPTED'}];
  assert.equal(buildOriginalRecoveryReviewModel([receipt],[journal]).items[0]!.status,'OUTCOME_UNCERTAIN');
});
