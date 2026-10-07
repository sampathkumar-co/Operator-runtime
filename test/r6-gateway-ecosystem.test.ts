import assert from 'node:assert/strict';
import test from 'node:test';
import { UniversalAgentGateway, createAgentGatewayProposal } from '../src/core/universal-agent-gateway.ts';
import { createGatewayEvent, createGatewayWebhookSubscription, signGatewayEvent, verifyGatewayEventSignature } from '../src/core/gateway-webhook.ts';
import { assertEcosystemCompatible } from '../src/core/ecosystem-compatibility.ts';
import { simulateCapabilityExtension, runCapabilityAdversarialKit } from '../src/core/capability-simulator.ts';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore, PermissionProfile } from '../src/core/types.ts';

const permissions:PermissionProfile={allowedCapabilities:['file.read'],allowedRoots:['/tmp'],maxRisk:'read'};
const action:ActionRequest={id:'gateway-action',capability:'file.read',risk:'read',input:{path:'x'},provenance:{kind:'runtime'}};
const context={schemaVersion:1 as const,principalId:'principal:test',actionId:action.id};

test('all five R6 transports share identical authority and execution semantics',async()=>{
  const seen:Array<{principal:string;capabilities:string[]}>=[];  
  const executor={
    async execute(a:ActionRequest,p:PermissionProfile):Promise<ActionResult>{
      seen.push({principal:'principal:test',capabilities:[...p.allowedCapabilities]});
      return {ok:true,capability:a.capability,provider:'probe',output:{ok:true},evidence:[],durationMs:1};
    }
  };
  const gateway=new UniversalAgentGateway({
    executor,
    authorizer:{permissionsFor(principal){assert.equal(principal,'principal:test');return permissions;}}
  });
  const receipts=[];
  for(const transport of ['mcp','openai','automation','local-sdk','enterprise-sdk'] as const){
    receipts.push(await gateway.execute(createAgentGatewayProposal({
      transport,principalId:'principal:test',executionContext:context,action,adapterVersion:'1.0.0',proposedAt:'2026-10-07T00:00:00.000Z'
    })));
  }
  assert.equal(receipts.length,5);
  assert.ok(receipts.every(r=>r.result.ok&&r.actionId===action.id));
  assert.deepEqual(seen.map(x=>x.capabilities),Array.from({length:5},()=>['file.read']));
});

test('request-bound gateway authority rejects principal spoofing',async()=>{
  const gateway=new UniversalAgentGateway({
    executor:{async execute(a:ActionRequest):Promise<ActionResult>{return{ok:true,capability:a.capability,provider:'probe',evidence:[],durationMs:1};}},
    authorizer:{permissionsFor(){return permissions;}}
  });
  const proposal=createAgentGatewayProposal({
    transport:'local-sdk',principalId:'attacker',executionContext:{schemaVersion:1,principalId:'attacker',actionId:action.id},
    action,adapterVersion:'1.0.0',proposedAt:'2026-10-07T00:00:00.000Z'
  });
  await assert.rejects(()=>gateway.executeAuthorized(proposal,permissions,'local-user'),(e:any)=>e?.code==='AGENT_GATEWAY_PRINCIPAL_MISMATCH');
});

test('signed webhook envelopes are tamper evident and subscriptions reject private endpoints',()=>{
  const subscription=createGatewayWebhookSubscription({
    id:'sub:1',endpoint:'https://events.vendor.com/mecord',eventKinds:['operation.completed'],createdAt:'2026-10-07T00:00:00.000Z'
  });
  assert.equal(subscription.enabled,true);
  for(const endpoint of ['https://127.0.0.1/hook','https://[fe80::1]/hook','https://metadata.internal/hook']){
    assert.throws(()=>createGatewayWebhookSubscription({
      id:'sub:bad',endpoint,eventKinds:['operation.completed']
    }),(error:any)=>error?.code==='GATEWAY_WEBHOOK_INVALID');
  }
  const event=createGatewayEvent({kind:'operation.completed',occurredAt:'2026-10-07T00:00:01.000Z',subjectId:'task:1',data:{status:'verified'}});
  const signed=signGatewayEvent(event,'s'.repeat(32));
  assert.equal(verifyGatewayEventSignature(signed.body,signed.signature,'s'.repeat(32)),true);
  assert.equal(verifyGatewayEventSignature(signed.body+'x',signed.signature,'s'.repeat(32)),false);
});

test('compatibility matrix enforces versioned trust semantics',()=>{
  const entry=assertEcosystemCompatible({integration:'openai-agents',gatewaySchemaVersion:1,capabilitySdkVersion:1,adapterVersion:'1.0.0'});
  assert.equal(entry.transport,'openai');
  assert.throws(()=>assertEcosystemCompatible({integration:'openai-agents',gatewaySchemaVersion:2,capabilitySdkVersion:1,adapterVersion:'1.0.0'}),/incompatible/);
});

test('local simulator and adversarial kit exercise manifest-bound providers',async()=>{
  const score:CapabilityScore={reliability:1,latency:1,determinism:1,security:1,reversibility:1,informationQuality:1,interactionCost:0};
  const provider:CapabilityProvider={
    name:'sim-probe',supports:a=>a.capability==='file.read',score:()=>score,
    async execute(a){return{ok:true,capability:a.capability,provider:'sim-probe',output:{},evidence:[],durationMs:1};}
  };
  const manifest={
    sdkVersion:1 as const,id:'sim.files',version:'1.0.0',displayName:'Simulator Files',
    provenance:{source:'test',packageDigest:'a'.repeat(64)},
    capabilities:[{capability:'file.read',risk:'read' as const,deterministic:true,reversible:true,verification:'runtime' as const,reconciliation:'not-required' as const,inputSchemaVersion:1 as const,inputMaxBytes:2048,outputMaxBytes:2048,cancellation:'required' as const,resourceKinds:['file']}]
  };
  const receipt=await simulateCapabilityExtension({manifest,provider,cases:[{id:'read',action:{...action,input:{}},expected:'success'}],observedAt:'2026-10-07T00:00:00.000Z'});
  assert.equal(receipt.failed,0);
  assert.equal((await runCapabilityAdversarialKit({manifest,provider})).passed,true);
});
