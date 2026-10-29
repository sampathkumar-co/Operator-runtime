import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';
import { OriginalRecoveryOwnerResolution } from '../apps/local-agent/src/operator-pre-dispatch-adjudication.ts';
import { buildOriginalRecoveryReviewModel } from '../src/core/original-recovery-ux.ts';
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

test('authenticated local Control Center reviews original receipts in one click without recovery authority', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-recovery-browser-ui-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const receipts = new LocalActionExecutionStore(root);
  const journal = new ActionTransitionJournal(root);
  const action: ActionRequest = { id: crypto.randomUUID(), capability: 'file.create', risk: 'write',
    input: { path: path.join(root, 'PRIVATE_FIXTURE.txt'), content: 'PRIVATE_CONTENT' },
    provenance: { kind: 'chatgpt' } };
  await receipts.begin(action);
  await journal.prepare({ action, ownerKind: 'task', ownerId: 'PRIVATE_OWNER', resourceKeys: ['PRIVATE_RESOURCE'] });
  const bearer = 'c'.repeat(64);
  const runtime = new OperatorRuntime();
  const agent = createLocalAgentServer({ runtime, token: bearer,
    permissions: { allowedCapabilities: ['file.create'], allowedRoots: [root],
      allowDestructive: false, allowExternalWrites: false, allowSystemChanges: false },
    actionExecutions: receipts, agentKernel: { journal } as any });
  t.after(async () => { await agent.close(); await runtime.close(); });
  const bound = await agent.listen('127.0.0.1', 0);
  const base = 'http://127.0.0.1:' + bound.port;
  const route = base + '/v1/control-center/original-recovery/browser';
  assert.equal((await fetch(route)).status, 401);
  const issue = await fetch(base + '/v1/control-center/browser-login/code', {
    method: 'POST', headers: { authorization: 'Bearer ' + bearer } });
  assert.equal(issue.status, 200);
  const code = ((await issue.json()) as { code: string }).code;
  const login = await fetch(base + '/v1/control-center/browser-login', {
    method: 'POST', headers: { origin: base, 'x-mecord-control-center': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ code }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const read = await fetch(route, { headers: { cookie } });
  assert.equal(read.status, 200);
  const response = await read.json() as any;
  assert.equal(response.model.items.length, 1);
  assert.match(response.model.items[0].actionId, /^review:[0-9a-f]{64}$/);
  assert.equal(response.model.items[0].status, 'REVIEW_REQUIRED');
  assert.equal(response.model.items[0].canApproveOnWebsite, false);
  assert.equal(response.model.websiteApprovalAvailable, false);
  for (const forbidden of ['PRIVATE_FIXTURE', 'PRIVATE_CONTENT', 'PRIVATE_OWNER', 'PRIVATE_RESOURCE',
    action.id, 'actionHash', 'resourceKeys', bearer]) {
    assert.equal(JSON.stringify(response).includes(forbidden), false);
  }
  assert.equal((await fetch(route, { headers: { cookie, origin: 'https://evil.invalid' } })).status, 401);
  assert.equal((await fetch(route, { headers: { authorization: 'Bearer ' + bearer } })).status, 403);
  assert.equal((await fetch(base + '/v1/control-center/original-recovery',
    { headers: { cookie } })).status, 401);
  for (const bad of ['0', '201', 'nan']) {
    assert.equal((await fetch(route + '?limit=' + bad, { headers: { cookie } })).status, 400);
  }
  assert.equal((await fetch(route + '/adjudicate', { method: 'POST',
    headers: { cookie, origin: base, 'x-mecord-control-center': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'AUTHORIZE-NO-REPLAY' }) })).status, 401);
  assert.equal((await receipts.listOperatorPendingReceipts()).length, 1);
  assert.equal((await journal.inspect(action.id)).state, 'PREPARED');
  await assert.rejects(fs.access(path.join(root, 'PRIVATE_FIXTURE.txt')));
});


test('native owner resolution refuses forged or ineligible case and keeps journal untouched on denial', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-native-denial-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const receipts = new LocalActionExecutionStore(root);
  const journal = new ActionTransitionJournal(root);
  const action: ActionRequest = { id: crypto.randomUUID(), capability: 'file.create', risk: 'write',
    input: { path: path.join(root, 'NEVER_CREATED.txt'), content: 'SENSITIVE' }, provenance: { kind: 'chatgpt' } };
  await receipts.begin(action);
  await journal.prepare({ action, ownerKind: 'local-api', ownerId: action.id, resourceKeys: [] });
  const { items } = buildOriginalRecoveryReviewModel(
    await receipts.listOperatorPendingReceipts(200), await journal.list(1000));
  assert.equal(items.length, 1);
  assert.equal(items[0]!.status, 'REVIEW_REQUIRED');
  let inspected = 0; let adjudicated = 0;
  const stub = {
    inspect: async (id: string) => { inspected++; assert.equal(id, action.id); return { caseDigest: 'a'.repeat(64) }; },
    adjudicate: async () => { adjudicated++; throw new Error('must never sign on denial'); }
  } as any;
  const resolver = new OriginalRecoveryOwnerResolution(root, {
    adjudicator: stub, confirmOwner: async () => false
  });
  await assert.rejects(resolver.resolve('review:' + '0'.repeat(64)));
  await assert.rejects(resolver.resolve(action.id), 'raw action IDs must not work');
  assert.equal(inspected, 0);
  await assert.rejects(resolver.resolve(items[0]!.actionId));
  assert.equal(inspected, 1);
  assert.equal(adjudicated, 0);
  assert.equal((await journal.inspect(action.id)).state, 'PREPARED');
  assert.equal((await receipts.listOperatorPendingReceipts()).length, 1);
  await assert.rejects(fs.access(path.join(root, 'NEVER_CREATED.txt')));
});

test('signed original recovery is local cookie only, native gesture and CAS proof are server-side', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-native-browser-route-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const receipts = new LocalActionExecutionStore(root);
  const journal = new ActionTransitionJournal(root);
  const action: ActionRequest = { id: crypto.randomUUID(), capability: 'file.create', risk: 'write',
    input: { path: path.join(root, 'NEVER_EXECUTED.txt'), content: 'SECRET' }, provenance: { kind: 'chatgpt' } };
  await receipts.begin(action);
  await journal.prepare({ action, ownerKind: 'local-api', ownerId: action.id, resourceKeys: [] });
  const token = 'e'.repeat(64);
  let nativeGestures = 0; let signings = 0;
  const digest = 'a'.repeat(64);
  const resolution = new OriginalRecoveryOwnerResolution(root, {
    adjudicator: {
      inspect: async (id: string) => { assert.equal(id, action.id); return { caseDigest: digest }; },
      adjudicate: async (input: any) => {
        signings++;
        assert.equal(input.actionId, action.id);
        assert.equal(input.caseDigest, digest);
        assert.equal(input.confirmation, 'AUTHORIZE-NO-REPLAY:' + digest);
        assert.equal(input.ownerAttestation, 'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED');
        return { actionId: action.id, state: 'INTERRUPTED', epoch: 1, caseDigest: digest };
      }
    } as any,
    confirmOwner: async () => { nativeGestures++; return true; }
  });
  const runtime = new OperatorRuntime();
  const agent = createLocalAgentServer({ runtime, token,
    permissions: { allowedCapabilities: ['file.create'], allowedRoots: [root] },
    actionExecutions: receipts, agentKernel: { journal } as any,
    originalRecoveryResolution: resolution
  });
  t.after(async () => { await agent.close(); await runtime.close(); });
  const bound = await agent.listen('127.0.0.1', 0);
  const base = 'http://127.0.0.1:' + bound.port;
  const route = base + '/v1/control-center/original-recovery/browser/resolve';
  const header = { origin: base, 'x-mecord-control-center': '1', 'content-type': 'application/json' };
  const issue = await fetch(base + '/v1/control-center/browser-login/code', {
    method: 'POST', headers: { authorization: 'Bearer ' + token } });
  const code = ((await issue.json()) as { code: string }).code;
  const login = await fetch(base + '/v1/control-center/browser-login', {
    method: 'POST', headers: header, body: JSON.stringify({ code }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const headers = { ...header, cookie };
  const read = await fetch(base + '/v1/control-center/original-recovery/browser', { headers: { cookie } });
  const model = await read.json() as any;
  const reference = model.model.items[0].actionId;
  const body = JSON.stringify({ reference });
  assert.equal((await fetch(route, { method: 'POST', headers: header, body })).status, 401);
  assert.equal((await fetch(route, { method: 'POST',
    headers: { ...headers, origin: 'https://attacker.invalid' }, body })).status, 401);
  assert.equal((await fetch(route, { method: 'POST',
    headers: { ...headers, authorization: 'Bearer ' + token }, body })).status, 403);
  assert.equal((await fetch(route, { method: 'POST',
    headers: { ...headers, 'x-operator-relay-request': '1' }, body })).status !== 200, true);
  assert.equal((await fetch(route, { method: 'POST', headers, body: JSON.stringify({ reference: action.id }) })).status, 400);
  assert.equal((await fetch(route, { method: 'POST', headers,
    body: JSON.stringify({ reference: 'review:' + '0'.repeat(64) }) })).status, 409);
  assert.equal(nativeGestures, 0);
  const signed = await fetch(route, { method: 'POST', headers, body });
  assert.equal(signed.status, 200);
  const response = await signed.json() as any;
  assert.equal(response.outcome.status, 'FENCED_NO_REPLAY');
  assert.equal(nativeGestures, 1);
  assert.equal(signings, 1);
  assert.equal(JSON.stringify(response).includes(action.id), false);
  assert.equal(JSON.stringify(response).includes(digest), false);
  // The stub emulates the signer only: HTTP and service do NOT run provider actions.
  assert.equal((await journal.inspect(action.id)).state, 'PREPARED');
  await assert.rejects(fs.access(path.join(root, 'NEVER_EXECUTED.txt')));
});
