import assert from 'node:assert/strict';
import test from 'node:test';
import { TrustedAgentGatewayClient, gatewayResultDigest } from '../src/core/agent-gateway-sdk.ts';
import { signAgentWebhook, verifyAgentWebhook } from '../src/core/agent-webhook.ts';

test('transport-neutral client binds adapter receipt to exact proposal digest',async()=>{
  const client=new TrustedAgentGatewayClient({
    transport:'local-sdk',
    principalId:'agent:test',
    adapterVersion:'1.0.0',
    clock:()=>new Date('2026-10-07T00:00:00.000Z')
  });
  const action={id:'read-1',capability:'file.read',risk:'read' as const,input:{path:'/tmp/a'},provenance:{kind:'chatgpt' as const}};
  const submitted=await client.submit(action,{
    async submit(proposal){
      return {
        schemaVersion:1,
        proposalDigest:proposal.digest,
        status:'COMPLETED',
        receivedAt:'2026-10-07T00:00:01.000Z',
        resultDigest:gatewayResultDigest({ok:true})
      };
    }
  });
  assert.equal(submitted.receipt.proposalDigest,submitted.proposal.digest);
  assert.equal(submitted.receipt.status,'COMPLETED');

  await assert.rejects(client.submit(action,{
    async submit(){return {schemaVersion:1,proposalDigest:'f'.repeat(64),status:'ACCEPTED',receivedAt:'2026-10-07T00:00:01.000Z'};}
  }),(error:any)=>error?.code==='AGENT_GATEWAY_RECEIPT_MISMATCH');
});

test('webhook SDK signs bounded payloads and rejects tampering',()=>{
  const subscription={schemaVersion:1 as const,id:'sub:1',endpoint:'https://hooks.example.invalid/events',eventTypes:['operation.completed'],enabled:true};
  const secret='s'.repeat(48);
  const signed=signAgentWebhook({subscription,deliveryId:'delivery:1',eventType:'operation.completed',occurredAt:'2026-10-07T00:00:00.000Z',payload:{operationId:'op:1',status:'VERIFIED'},secret});
  assert.equal(verifyAgentWebhook(signed,secret).payloadDigest,signed.payloadDigest);
  const tampered=structuredClone(signed);tampered.payload.status='FAILED';
  assert.throws(()=>verifyAgentWebhook(tampered,secret),/digest mismatch/);
});
