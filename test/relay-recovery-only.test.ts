import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';
import { isOriginalAuthorityConflict, originalRecoveryOnlyRouteAllowed } from '../apps/local-agent/src/relay-recovery-only.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { OperatorError } from '../src/core/errors.ts';

test('only exact native authority conflict may enter recovery-only mode', () => {
  assert.equal(isOriginalAuthorityConflict({ state:'DEGRADED',code:'RELAY_AUTHORITY_CONFLICT_REVIEW_REQUIRED',recoverable:false }),true);
  assert.equal(isOriginalAuthorityConflict({ state:'READY',code:'RELAY_AUTHORITY_CONFLICT_REVIEW_REQUIRED' }),false);
  assert.equal(isOriginalAuthorityConflict({ state:'DEGRADED',code:'RELAY_NETWORK_TIMEOUT',recoverable:false }),false);
  assert.equal(isOriginalAuthorityConflict({ state:'DEGRADED',code:'RELAY_AUTHORITY_CONFLICT_REVIEW_REQUIRED',recoverable:true }),false);
  assert.equal(isOriginalAuthorityConflict({ state:'SHUTTING_DOWN' },
    new OperatorError('RELAY_AUTHORITY_CONFLICT_REVIEW_REQUIRED','Expected original authority conflict')),true);
  assert.equal(isOriginalAuthorityConflict({ state:'SHUTTING_DOWN' },new Error('RELAY_AUTHORITY_CONFLICT_REVIEW_REQUIRED')),false);
});

test('recovery-only route allowlist never permits ordinary execution or state reset', () => {
  for (const [method, path] of [
    ['GET','/control-center'],
    ['POST','/v1/control-center/browser-login/windows'],
    ['GET','/v1/control-center/original-recovery/browser'],
    ['GET','/v1/control-center/recovery'],
    ['POST','/v1/control-center/original-recovery/browser/resolve']
  ]) assert.equal(originalRecoveryOnlyRouteAllowed(method,path),true);
  for (const [method,path] of [
    ['POST','/v1/execute'],['POST','/v1/gateway/execute'],['GET','/v1/approvals'],
    ['GET','/v1/tasks'],['GET','/v1/capabilities/readiness'],
    ['POST','/v1/device/reset'],['POST','/v1/emergency-stop'],
    ['DELETE','/v1/emergency-stop'],['POST','/v1/control-center/original-recovery'],
    ['POST','/v1/control-center/original-recovery/browser/resolve/extra']
  ]) assert.equal(originalRecoveryOnlyRouteAllowed(method,path),false);
});

test('dynamic recovery quarantine rejects even valid bearer ordinary operations, while local review stays usable', async t => {
  const runtime=new OperatorRuntime();
  const token='r'.repeat(64);
  let recoveryMode=false;
  const server=createLocalAgentServer({
    runtime,
    token,
    permissions:{allowedCapabilities:[],allowedRoots:[],allowDestructive:false,
      allowExternalWrites:false,allowSystemChanges:false},
    isOriginalRecoveryOnly:()=>recoveryMode
  });
  t.after(async()=>{await server.close();await runtime.close();});
  const bound=await server.listen('127.0.0.1',0);
  const base='http://127.0.0.1:'+bound.port;
  const bearer={authorization:'Bearer '+token};
  const first=await fetch(base+'/health');
  assert.equal(first.status,200);
  assert.equal(((await first.json()) as any).originalRecoveryOnly,false);
  recoveryMode=true;
  const second=await fetch(base+'/health');
  assert.equal(second.status,200);
  assert.equal(((await second.json()) as any).originalRecoveryOnly,true);
  const center=await fetch(base+'/control-center');
  assert.equal(center.status,200);
  for(const route of ['/v1/execute','/v1/gateway/execute','/v1/device/reset']){
    const response=await fetch(base+route,{method:'POST',headers:{...bearer,'content-type':'application/json'},body:'{}'});
    assert.equal(response.status,423,route);
    assert.equal(((await response.json()) as any).error.code,'ORIGINAL_RELAY_AUTHORITY_REVIEW_REQUIRED');
  }
  assert.equal((await fetch(base+'/v1/tasks',{headers:bearer})).status,423);
  const summary=await fetch(base+'/v1/control-center/recovery',{headers:bearer});
  assert.equal(summary.status,200);
  const review=await fetch(base+'/v1/control-center/original-recovery',{headers:bearer});
  assert.equal(review.status,503); // no journal configured; only the read-only recovery route remains reachable
  const missingAuth=await fetch(base+'/v1/control-center/original-recovery');
  assert.equal(missingAuth.status,401);
  const issue=await fetch(base+'/v1/control-center/browser-login/code',{method:'POST',headers:bearer});
  assert.equal(issue.status,200);
  const sessionCode=((await issue.json()) as any).code;
  const login=await fetch(base+'/v1/control-center/browser-login',{method:'POST',headers:{
    origin:base,'x-mecord-control-center':'1','content-type':'application/json'
  },body:JSON.stringify({code:sessionCode})});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie')!.split(';')[0];
  const read=await fetch(base+'/v1/control-center/original-recovery/browser',{headers:{cookie}});
  assert.equal(read.status,503); // no journal configured, but remains a reachable approved route
  assert.equal((await fetch(base+'/v1/execute',{method:'POST',headers:{
    cookie,origin:base,'x-mecord-control-center':'1','content-type':'application/json'
  },body:'{}'})).status,423);
  recoveryMode=false;
  assert.notEqual((await fetch(base+'/v1/tasks',{headers:bearer})).status,423);
});
