import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { MecordGatewayClient } from '../src/sdk/gateway-client.ts';
import { gatewayWebhookSubscription as packagedWebhookSubscription, MecordWebhookVerifier as PackagedWebhookVerifier } from '../packages/sdk-typescript/index.js';

test('TypeScript gateway client builds canonical proposals and calls only the gateway endpoint',async()=>{
  let seenUrl='';
  let seenInit:RequestInit|undefined;
  const client=new MecordGatewayClient({
    baseUrl:'http://127.0.0.1:9999',
    bearerToken:'t'.repeat(32),
    fetchImpl:async(input,init)=>{
      seenUrl=String(input);
      seenInit=init;
      return new Response(JSON.stringify({ok:true,receipt:{}}),{status:200,headers:{'content-type':'application/json'}});
    }
  });
  const proposal=client.proposal({
    transport:'local-sdk',
    principalId:'local-user',
    executionContext:{schemaVersion:1,actionId:'sdk-action'},
    action:{id:'sdk-action',capability:'file.read',risk:'read',input:{path:'x'},provenance:{kind:'runtime'}},
    adapterVersion:'1.0.0',
    proposedAt:'2026-10-07T00:00:00.000Z'
  });
  assert.match(proposal.digest,/^[0-9a-f]{64}$/);
  const result=await client.execute(proposal) as any;
  assert.equal(result.ok,true);
  assert.equal(seenUrl,'http://127.0.0.1:9999/v1/gateway/execute');
  assert.equal((seenInit?.headers as Record<string,string>).authorization,'Bearer '+ 't'.repeat(32));
});

test('TypeScript gateway client refuses insecure non-loopback HTTP',()=>{
  assert.throws(()=>new MecordGatewayClient({baseUrl:'http://example.com',bearerToken:'t'.repeat(32)}),/loopback/);
});


test('packaged TypeScript webhook subscription matches core public-target policy',()=>{
  assert.equal(packagedWebhookSubscription({id:'sub:ok',endpoint:'https://events.vendor.com/hook',eventKinds:['operation.completed']}).endpoint,'https://events.vendor.com/hook');
  for(const endpoint of [
    'https://127.0.0.1/hook',
    'https://169.254.169.254/hook',
    'https://[fe80::1]/hook',
    'https://metadata.internal/hook',
    'https://example.test/hook',
    'https://home.arpa/hook'
  ]) assert.throws(()=>packagedWebhookSubscription({id:'sub:bad',endpoint,eventKinds:['operation.completed']}),/public DNS hostname/);
});

test('packaged TypeScript webhook verifier accepts exact HMAC and rejects tampering',async()=>{
  const secret='s'.repeat(32);
  const body='{"kind":"operation.completed","ok":true}';
  const signature=crypto.createHmac('sha256',secret).update(body,'utf8').digest('hex');
  const verifier=new PackagedWebhookVerifier(secret);
  assert.deepEqual(await verifier.verify(body,signature),JSON.parse(body));
  await assert.rejects(()=>verifier.verify(body.replace('true','false'),signature),/signature is invalid/);
  await assert.rejects(()=>verifier.verify(body,'0'.repeat(64)),/signature is invalid/);
});
