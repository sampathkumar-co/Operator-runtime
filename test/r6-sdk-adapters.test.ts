import assert from 'node:assert/strict';
import test from 'node:test';
import {
  automationGatewayAdapter,
  enterpriseGatewayAdapter,
  gatewayWebhookSubscription,
  localSdkGatewayAdapter,
  mcpGatewayAdapter,
  MecordWebhookVerifier,
  openAiGatewayAdapter
} from '../src/sdk/index.ts';
import { createGatewayEvent, signGatewayEvent } from '../src/core/gateway-webhook.ts';

const action={
  id:'sdk-adapter-action',
  capability:'file.read',
  risk:'read' as const,
  input:{path:'sample.txt'},
  provenance:{kind:'runtime' as const}
};
const input={
  principalId:'principal:sdk-test',
  executionContext:{schemaVersion:1 as const,actionId:action.id},
  action,
  proposedAt:'2026-10-07T00:00:00.000Z'
};

test('all R6 transport adapters emit the same canonical trust envelope semantics',()=>{
  const adapters=[
    mcpGatewayAdapter(),
    openAiGatewayAdapter(),
    automationGatewayAdapter(),
    localSdkGatewayAdapter(),
    enterpriseGatewayAdapter()
  ];
  const proposals=adapters.map(adapter=>adapter.propose(input));
  assert.deepEqual(proposals.map(p=>p.transport),['mcp','openai','automation','local-sdk','enterprise-sdk']);
  for(const proposal of proposals){
    assert.equal(proposal.schemaVersion,1);
    assert.equal(proposal.principalId,input.principalId);
    assert.deepEqual(proposal.executionContext,input.executionContext);
    assert.deepEqual(proposal.action,action);
    assert.equal(proposal.adapterVersion,'1.0.0');
    assert.match(proposal.digest,/^[0-9a-f]{64}$/);
  }
  assert.throws(()=>mcpGatewayAdapter('not-semver'),/SemVer/);
});

test('webhook SDK creates bounded public subscriptions and verifies signed events',()=>{
  const subscription=gatewayWebhookSubscription({
    id:'sdk-subscription',
    endpoint:'https://events.example.com/mecord',
    eventKinds:['operation.completed'],
    createdAt:'2026-10-07T00:00:00.000Z'
  });
  assert.equal(subscription.enabled,true);
  assert.throws(()=>gatewayWebhookSubscription({
    id:'private-subscription',
    endpoint:'https://127.0.0.1/hook',
    eventKinds:['operation.completed']
  }),/private hosts/);

  const secret='s'.repeat(32);
  const event=createGatewayEvent({
    kind:'operation.completed',
    subjectId:'task:adapter-test',
    occurredAt:'2026-10-07T00:00:01.000Z',
    data:{status:'verified'}
  });
  const signed=signGatewayEvent(event,secret);
  const verifier=new MecordWebhookVerifier(secret);
  assert.deepEqual(verifier.verify(signed.body,signed.signature),event);
  assert.throws(()=>verifier.verify(signed.body+' ',signed.signature),/signature/);
});
