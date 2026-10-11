import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OperatorError } from '../src/core/errors.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

test('quarantine review API fails closed without independently configured operator authority',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'operator-quarantine-api-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const runtime=createRuntime({allowedRoots:[root],allowedExecutables:['node'],browserAutoLaunch:false});
  const token='b'.repeat(64), recoveryToken='r'.repeat(64);
  const agent=createLocalAgentServer({runtime,token,recoveryToken,permissions:{
    allowedCapabilities:['computer.inspect'],allowedRoots:[root]
  },organizations:{async adjudicateQuarantinedIdentity(){throw new Error('must not reach provider')}} as any});
  t.after(()=>Promise.allSettled([agent.close(),runtime.close()]));
  const bound=await agent.listen('127.0.0.1',0);
  const route=`http://127.0.0.1:${bound.port}/v1/organizations/${crypto.randomUUID()}/quarantines/review`;
  const request=await fetch(route,{method:'POST',headers:{
    authorization:`Bearer ${token}`,'content-type':'application/json',
    'x-operator-recovery-token':recoveryToken
  },body:JSON.stringify({targetKey:'service',returnedMissionId:crypto.randomUUID(),providerClaim:{claim:{},signature:'invalid'}})});
  assert.equal(request.status,503);
  assert.equal((await request.json() as any).error.code,'QUARANTINE_REVIEW_NOT_CONFIGURED');
});

test('quarantine API requires recovery secret and independently scoped identity; body cannot impersonate operator',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'operator-quarantine-api-auth-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const runtime=createRuntime({allowedRoots:[root],allowedExecutables:['node'],browserAutoLaunch:false});
  const token='b'.repeat(64),recoveryToken='r'.repeat(64);
  const programId=crypto.randomUUID(),returnedMissionId=crypto.randomUUID();
  let reviews=0, decisions=0, denied=false;
  const coordinator={
    async adjudicateQuarantinedIdentity(input:any){
      decisions++;
      assert.equal(input.programId,programId);
      assert.equal(input.targetKey,'service');
      assert.equal(input.returnedMissionId,returnedMissionId);
      assert.equal(input.operatorId,'independently-authenticated-security-admin');
      return {intentId:crypto.randomUUID(),classification:'verified-unrelated',operatorId:input.operatorId};
    }
  };
  const agent=createLocalAgentServer({
    runtime,token,recoveryToken,
    permissions:{allowedCapabilities:['computer.inspect'],allowedRoots:[root]},
    organizations:coordinator as any,
    quarantineReviewAuthorization:async (scope)=>{
      reviews++;
      assert.deepEqual(scope,{programId,targetKey:'service',returnedMissionId});
      if(denied)throw new OperatorError('QUARANTINE_OPERATOR_UNAUTHORIZED','Reviewer lacks scoped authority');
      return {operatorId:'independently-authenticated-security-admin'};
    }
  });
  t.after(()=>Promise.allSettled([agent.close(),runtime.close()]));
  const {port}=await agent.listen('127.0.0.1',0);
  const route=`http://127.0.0.1:${port}/v1/organizations/${programId}/quarantines/review`;
  const valid={targetKey:'service',returnedMissionId,providerClaim:{claim:{},signature:'independent-provider-proof'}};
  const request=async (body:unknown,extra:Record<string,string>={})=>
    await fetch(route,{method:'POST',headers:{authorization:`Bearer ${token}`,
      'content-type':'application/json',...extra},body:JSON.stringify(body)});
  let response=await request(valid);
  assert.equal(response.status,401);
  assert.equal(reviews,0);
  response=await request(valid,{'x-operator-recovery-token':'wrong'});
  assert.equal(response.status,401);
  assert.equal(reviews,0);
  response=await request({...valid,operatorId:'attacker-claiming-security-admin'},
    {'x-operator-recovery-token':recoveryToken});
  assert.equal(response.status,400);
  assert.equal(reviews,0);
  response=await request(valid,{'x-operator-recovery-token':recoveryToken});
  assert.equal(response.status,200);
  assert.equal((await response.json() as any).decision.operatorId,'independently-authenticated-security-admin');
  assert.equal(reviews,1);
  assert.equal(decisions,1);
  denied=true;
  response=await request(valid,{'x-operator-recovery-token':recoveryToken});
  assert.equal(response.status,403);
  assert.equal((await response.json() as any).error.code,'QUARANTINE_OPERATOR_UNAUTHORIZED');
  assert.equal(decisions,1,'independent permission failure must not reach provider decision');
});
