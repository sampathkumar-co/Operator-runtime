import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSafeControlCenterDiagnosticExport } from '../src/core/control-center-diagnostic-export.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';
import { browserUiRouteAllowed } from '../apps/local-agent/src/control-center-session.ts';
import { renderControlCenter } from '../apps/local-agent/src/control-center.ts';

const poison = {
  token: 'TOP_SECRET_BEARER_4376611',
  path: 'C:\\Users\\Person\\Secrets\\confidential.txt',
  device: 'OWNER_PRIVATE_DEVICE_MRNU23B2',
  receipt: 'ORIGINAL_PROTECTED_RECEIPT_SHOULD_NEVER_EXPORT',
  connection: 'wss://internal.secret.example/relay?auth=SECRET'
};
function input() {
  return {
    schemaVersion: 1, service:'operator-local-agent',productVersion:'2.0.6',
    emergencyStopped:true,recoveryConfigured:true,authorizedRootCount:3,
    device:{configured:true,deviceName:poison.device,secret:poison.token},
    runtime:{secret:poison.token,oauth:poison.connection,
      config:{root:poison.path,receipt:poison.receipt}},
    peerCounts:{total:2,active:1,revoked:1,token:poison.token},
    taskCounts:{PENDING:4,FAILED:2,ownerObjective:poison.path},
    approvalCounts:{pending:2,consumed:1,target:poison.path},
    issues:[{code:'RELAY_DEGRADED',severity:'warning',guidance:poison.receipt}],
    originalReceipts:[poison.receipt],logs:[poison.token]
  };
}
function noPoison(value:unknown) {
  const text = JSON.stringify(value);
  for (const [label, secret] of Object.entries(poison)) {
    assert.equal(text.includes(secret),false,label+' leaked into exported bundle');
  }
  assert.equal(text.includes('deviceName'),true,'only allowlisted omitted *labels* may appear');
  assert.equal(text.includes('"runtime":'),false);
  assert.equal(text.includes('"logs":'),false);
}
test('C10 diagnostic export is fixed allowlist with no secrets, names, paths or receipts',()=>{
  const data=buildSafeControlCenterDiagnosticExport(input(),'2026-10-25T04:00:00.000Z');
  assert.equal(data.schemaVersion,1);
  assert.equal(data.kind,'MECORD_SAFE_DIAGNOSTIC_EXPORT');
  assert.equal(data.productVersion,'2.0.6');
  assert.equal(data.configuration.authorizedRootCount,3);
  assert.deepEqual(data.issueCodes,['RELAY_DEGRADED']);
  assert.equal(data.peerCounts.total,2);
  assert.equal(data.taskCounts.PENDING,4);
  assert.equal(data.approvalCounts.pending,2);
  assert.equal(data.redaction.originalReceipts,'NOT_EXPORTED');
  noPoison(data);
  const {sha256,...payload}=data;
  assert.equal(sha256,crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'));
  assert.ok(Buffer.byteLength(JSON.stringify(data),'utf8')<12*1024);
});
test('C10 malformed or unexpected exported issue/counter can never be copied as attacker-controlled prose',()=>{
  for(const x of [
    {...input(),issues:[{code:poison.receipt}]},
    {...input(),issues:'not-array'},
    {...input(),taskCounts:{PENDING:-1}},
    {...input(),peerCounts:{total:Infinity}},
    {...input(),productVersion:'2.0.6\n'+poison.token},
    {...input(),authorizedRootCount:1.5},
    {...input(),device:{configured:'maybe'}}
  ]) assert.throws(()=>buildSafeControlCenterDiagnosticExport(x,'2026-10-25T04:00:00.000Z'),
    (err:any)=>err.code==='CONTROL_CENTER_EXPORT_INVALID');
});
test('C10 read-only dashboard export route stays origin scoped and cannot mutate approval or recovery',()=>{
  assert.equal(browserUiRouteAllowed('GET','/v1/control-center/diagnostics/export'),true);
  assert.equal(browserUiRouteAllowed('POST','/v1/control-center/diagnostics/export'),false);
  assert.equal(browserUiRouteAllowed('DELETE','/v1/control-center/diagnostics/export'),false);
  assert.equal(browserUiRouteAllowed('GET','/v1/control-center/diagnostics/export/anything'),false);
  const html=renderControlCenter('safedashnonce');
  assert.ok(html.includes('id="exportDiagnostics"'));
  assert.ok(html.includes('/v1/control-center/diagnostics/export'));
  assert.ok(!html.includes(poison.token));
  assert.ok(!html.includes('localStorage'));
});
test('C10 true local HTTP export accepts bearer or one-time-code browser session, never anonymous',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-diagnostics-export-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const runtime=createRuntime({allowedRoots:[root],allowedExecutables:['node']});
  const token='t'.repeat(64);
  const agent=createLocalAgentServer({
    runtime,token,recoveryToken:'z'.repeat(64),
    permissions:{allowedCapabilities:['computer.inspect'],allowedRoots:[root]},
    getRuntimeStatus:()=>({relay:{state:'DEGRADED',privateBearer:poison.token,
      data:{root:poison.path,receipt:poison.receipt,url:poison.connection}}})
  });
  t.after(()=>Promise.allSettled([agent.close(),runtime.close()]));
  const bound=await agent.listen('127.0.0.1',0);
  const base='http://127.0.0.1:'+bound.port;
  const endpoint=base+'/v1/control-center/diagnostics/export';
  const unauth=await fetch(endpoint);assert.equal(unauth.status,401);
  const bearer=await fetch(endpoint,{headers:{authorization:'Bearer '+token}});
  assert.equal(bearer.status,200);
  const b=(await bearer.json() as any).export;
  assert.equal(b.kind,'MECORD_SAFE_DIAGNOSTIC_EXPORT');
  assert.equal(b.configuration.authorizedRootCount,1);
  assert.deepEqual(b.issueCodes,['DEVICE_IDENTITY_MISSING','RELAY_DEGRADED']);
  noPoison(b);
  const original=await fetch(base+'/v1/control-center/diagnostics',{
    headers:{authorization:'Bearer '+token}});
  assert.equal(original.status,200);
  assert.ok(JSON.stringify(await original.json()).includes(poison.token),
    'source diagnostics may contain runtime fields; support export must independently allowlist them');
  const issued=await fetch(base+'/v1/control-center/browser-login/code',{
    method:'POST',headers:{authorization:'Bearer '+token}});
  const {code}=await issued.json() as {code:string};
  const signedIn=await fetch(base+'/v1/control-center/browser-login',{
    method:'POST',headers:{
      origin:base,'x-mecord-control-center':'1','content-type':'application/json'
    },body:JSON.stringify({code})});
  assert.equal(signedIn.status,200);
  const cookie=signedIn.headers.get('set-cookie')!.split(';')[0];
  const dashboard=await fetch(endpoint,{headers:{cookie,origin:base}});
  assert.equal(dashboard.status,200);
  noPoison((await dashboard.json() as any).export);
  const forbidden=await fetch(endpoint,{headers:{cookie,origin:'https://evil.example'}});
  assert.equal(forbidden.status,401);
});
