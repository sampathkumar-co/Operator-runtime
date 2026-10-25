import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildRedactedControlCenterDiagnostics } from '../src/core/control-center-diagnostic-export.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';
import { browserUiRouteAllowed } from '../apps/local-agent/src/control-center-session.ts';

const sensitive = {
  authorization: 'Bearer supersecret-local-token',
  deviceName: 'SAMPATH PRIVATE LAPTOP',
  accountId: 'secret-account-991',
  password: 'private-password-test',
  protectedReceipt: 'original-uncertain-protected-receipt',
  root: 'C:\\Users\\private\\project\\SECRETS',
  cookie: 'mecord_cc_session=not-for-export'
};
const projection = {
  productVersion:'2.0.6',emergencyStopped:true,recoveryConfigured:true,
  authorizedRootCount:2,device:{configured:true,deviceName:sensitive.deviceName, token:sensitive.authorization},
  peerCounts:{total:3,active:2,revoked:1,accountId:sensitive.accountId},
  approvalCounts:{pending:2,approved:0,inUse:0,consumed:4,denied:1,expired:0,token:sensitive.cookie},
  taskCounts:{VERIFIED:6,BLOCKED:1,FAILED:2,accountId:0},
  runtime:{
    relay:{state:'DEGRADED', bearer:sensitive.authorization,
      originalReceipt:sensitive.protectedReceipt},
    device:{root:sensitive.root,password:sensitive.password}
  },
  issues:[
    {code:'RELAY_DEGRADED',guidance:sensitive.password},
    {code:'ATTACKER_STORED_TOKEN',severity:'critical',guidance:sensitive.cookie}
  ],
  arbitrarySecret:sensitive.protectedReceipt
};
test('C10 export constructs only allowed primitive aggregates, never recursive raw diagnostics',()=>{
  const result=buildRedactedControlCenterDiagnostics(projection,new Date('2026-10-25T04:00:00Z'));
  const encoded=JSON.stringify(result);
  for (const value of Object.values(sensitive)) {
    assert.ok(!encoded.includes(value), 'export leaked sensitive value: '+value.slice(0,15));
  }
  assert.deepEqual(result.issueCodes,['RELAY_DEGRADED']);
  assert.equal(result.localRuntime.relayState,'DEGRADED');
  assert.equal(result.localRuntime.authorizedRootCount,2);
  assert.equal(result.approvalSummary.pending,2);
  assert.equal(result.taskSummary.totalKnownStates,9);
  assert.equal(result.physicalAcceptance,'NOT_ATTESTED');
  assert.equal(result.releaseAuthorization,'NOT_GRANTED');
  const withoutDigest={...result};
  delete (withoutDigest as {sha256?:string}).sha256;
  assert.equal(result.sha256,crypto.createHash('sha256').update(JSON.stringify(withoutDigest)).digest('hex'));
});
test('C10 malicious dynamic issue codes, status and unbounded counts are not serialized',()=>{
  const unsafe=buildRedactedControlCenterDiagnostics({
    ...projection,
    productVersion:'2.0.6\n'+sensitive.password,
    runtime:{relay:{state:sensitive.authorization}},
    taskCounts:{VERIFIED:9.5,privateUser:sensitive.password},
    approvalCounts:{pending:1_000_000_001},
    peerCounts:{total:-2},
    issues:Array.from({length:200},()=>({code:sensitive.password, guidance:sensitive.root}))
  });
  assert.equal(unsafe.productVersion,'UNAVAILABLE');
  assert.equal(unsafe.localRuntime.relayState,'UNKNOWN');
  assert.equal(unsafe.taskSummary.totalKnownStates,null);
  assert.equal(unsafe.approvalSummary.pending,null);
  assert.equal(unsafe.fleetSummary.total,null);
  assert.deepEqual(unsafe.issueCodes,[]);
});
test('C10 browser session is allowed only exact download route, not recovery or arbitrary export paths',()=>{
  assert.equal(browserUiRouteAllowed('GET','/v1/control-center/diagnostics/export'),true);
  assert.equal(browserUiRouteAllowed('GET','/v1/control-center/diagnostics/export/receipt'),false);
  assert.equal(browserUiRouteAllowed('POST','/v1/control-center/diagnostics/export'),false);
  assert.equal(browserUiRouteAllowed('GET','/v1/private-diagnostics'),false);
});
test('C10 authenticated browser download refuses unauthenticated and cross-site request, never includes bearer or device name',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-export-'));
  t.after(async()=>fs.rm(root,{force:true,recursive:true}));
  const runtime=createRuntime({allowedRoots:[root],allowedExecutables:['node']});
  const token='n'.repeat(64);
  const server=createLocalAgentServer({
    runtime,token,permissions:{allowedCapabilities:['computer.inspect'],allowedRoots:[root]},
    getRuntimeStatus:async()=>({relay:{state:'DEGRADED', bearer:sensitive.authorization},
      secret:sensitive.protectedReceipt})
  });
  t.after(async()=>{await Promise.allSettled([server.close(),runtime.close()]);});
  const bound=await server.listen('127.0.0.1',0);
  const base='http://127.0.0.1:'+bound.port;
  const route='/v1/control-center/diagnostics/export';
  assert.equal((await fetch(base+route)).status,401);
  const codeRes=await fetch(base+'/v1/control-center/browser-login/code',{
    method:'POST',headers:{authorization:'Bearer '+token}
  });
  assert.equal(codeRes.status,200);
  const {code}=await codeRes.json() as {code:string};
  const login=await fetch(base+'/v1/control-center/browser-login',{
    method:'POST',headers:{origin:base,'x-mecord-control-center':'1','content-type':'application/json'},
    body:JSON.stringify({code})
  });
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await fetch(base+route,{headers:{cookie,origin:'https://evil.example'}})).status,401);
  const download=await fetch(base+route,{headers:{cookie}});
  assert.equal(download.status,200);
  assert.equal(download.headers.get('cache-control'),'no-store');
  assert.match(download.headers.get('content-disposition')!,/attachment; filename="mecord-support-redacted.json"/);
  const body=await download.text();
  assert.ok(Buffer.byteLength(body)<8192);
  assert.equal(JSON.parse(body).artifactKind,'MECORD_REDACTED_LOCAL_SUPPORT_DIAGNOSTICS');
  for(const value of [token,...Object.values(sensitive),root])assert.equal(body.includes(value),false);
  assert.equal((await fetch(base+'/v1/control-center/diagnostics/export/private',{headers:{cookie}})).status,401);
});
