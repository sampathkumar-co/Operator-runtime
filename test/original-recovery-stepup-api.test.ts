import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { OriginalRecoveryWebAuthnVerifier } from '../apps/local-agent/src/original-recovery-webauthn.ts';

test('web owner step-up only signs exact bound case after verified credential and protected origin', async t => {
  const token='u'.repeat(64);
  const {privateKey,publicKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const credentialId=crypto.randomBytes(32).toString('base64url');
  const caseInfo={
    actionId:'mcp-test-1234567890123456',actionDigest:'1'.repeat(64),
    receiptAuthorityHash:'2'.repeat(64),receiptOwnerId:'owner',
    journalGeneration:1,transitionsDigest:'3'.repeat(64),recoveryEpoch:1,
    deviceId:'trusted-device',deviceFingerprint:'Q'.repeat(43),caseDigest:'4'.repeat(64)
  };
  const origin='http://localhost:8300';
  const verifier=new OriginalRecoveryWebAuthnVerifier({
    rpId:'localhost',origin,
    credential:{credentialId,publicKeyPem:publicKey.export({format:'pem',type:'spki'}).toString(),
      deviceId:caseInfo.deviceId,deviceFingerprint:caseInfo.deviceFingerprint,signCount:0,deviceBound:true}
  });
  let signed=0;
  const adjudicator={
    async inspect(actionId:string){assert.equal(actionId,caseInfo.actionId);return caseInfo},
    async adjudicate(arg:any){
      assert.equal(arg.caseDigest,caseInfo.caseDigest);
      assert.equal(arg.confirmation,'AUTHORIZE-NO-REPLAY:'+caseInfo.caseDigest);
      signed++;
      return {actionId:arg.actionId,state:'INTERRUPTED',epoch:1,caseDigest:arg.caseDigest};
    }
  };
  const runtime=createRuntime({allowedRoots:[process.cwd()],allowedExecutables:['node']});
  const agent=createLocalAgentServer({runtime,token,
    permissions:{allowedRoots:[process.cwd()],allowedCapabilities:['computer.inspect']},
    originalRecoveryOwner:{verifier,adjudicator} as any
  });
  t.after(async()=>{await agent.close();await runtime.close()});
  const {port}=await agent.listen('127.0.0.1',0);
  const base='http://127.0.0.1:'+port+'/v1/control-center/original-recovery/';
  const headers={
    authorization:'Bearer '+token,host:'localhost:8300',origin,
    'sec-fetch-site':'same-origin','x-mecord-owner-intent':'permanent-no-replay',
    'content-type':'application/json'
  };
  const post=(route:string,body:unknown,extraHeaders:Record<string,string>={})=>new Promise<{
    status:number;json:()=>Promise<any>;text:()=>Promise<string>;
  }>((resolve,reject)=>{
    const data=JSON.stringify(body);
    const req=http.request({hostname:'127.0.0.1',port,path:'/v1/control-center/original-recovery/'+route,
      method:'POST',headers:{...headers,...extraHeaders,'content-length':Buffer.byteLength(data)}},res=>{
      const chunks:Buffer[]=[];
      res.on('data',(chunk:Buffer)=>chunks.push(chunk));
      res.on('end',()=>{
        const payload=Buffer.concat(chunks).toString('utf8');
        resolve({status:res.statusCode??0,json:async()=>JSON.parse(payload),text:async()=>payload});
      });
    });
    req.on('error',reject);req.end(data);
  });
  assert.equal((await post('challenge',{actionId:caseInfo.actionId},{origin:'https://attacker.example'})).status,403);
  assert.equal((await post('challenge',{actionId:caseInfo.actionId},{'x-operator-relay-request':'1'})).status,403);
  const incomplete=await post('confirm',{actionId:caseInfo.actionId,ownerAttested:true});
  assert.equal(incomplete.status,409,await incomplete.text());
  assert.equal(signed,0);
  const challengeResponse=await post('challenge',{actionId:caseInfo.actionId});
  assert.equal(challengeResponse.status,200);
  const challenge=(await challengeResponse.json() as any).challenge;
  const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:challenge.challenge,origin,crossOrigin:false}));
  const auth=Buffer.alloc(37);
  crypto.createHash('sha256').update('localhost').digest().copy(auth);
  auth[32]=0x05;auth.writeUInt32BE(1,33);
  const signature=crypto.sign('sha256',Buffer.concat([auth,crypto.createHash('sha256').update(client).digest()]),privateKey);
  const proof={id:credentialId,response:{
    clientDataJSON:client.toString('base64url'),
    authenticatorData:auth.toString('base64url'),signature:signature.toString('base64url')
  }};
  const intent={actionId:caseInfo.actionId,ownerAttested:true,caseDigest:caseInfo.caseDigest,
    challengeId:challenge.challengeId,assertion:proof};
  const result=await post('confirm',intent);
  assert.equal(result.status,200);
  assert.equal((await result.json() as any).result.receiptReconciled,false);
  assert.equal(signed,1);
  assert.equal((await post('confirm',intent)).status,409);
  assert.equal(signed,1);
});
