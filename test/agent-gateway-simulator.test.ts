import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentGatewaySimulator } from '../src/core/agent-gateway-simulator.ts';
import { TrustedAgentGatewayClient } from '../src/core/agent-gateway-sdk.ts';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore, PermissionProfile } from '../src/core/types.ts';

const score:CapabilityScore={reliability:1,latency:0,determinism:1,security:1,reversibility:1,informationQuality:1,interactionCost:0};
const provider:CapabilityProvider={
  name:'third-party.safe-read',
  supports:(action)=>action.capability==='file.read',
  score:()=>score,
  execute:async(action:ActionRequest):Promise<ActionResult>=>({ok:true,capability:action.capability,provider:'third-party.safe-read',output:{text:'ok'},evidence:[{kind:'simulation',status:'pass',message:'read verified'}],durationMs:1})
};
const manifest={
  sdkVersion:1 as const,id:'third-party.safe-read',version:'1.0.0',displayName:'Safe Read',
  provenance:{source:'https://example.invalid/source',packageDigest:'a'.repeat(64)},
  capabilities:[{capability:'file.read',risk:'read' as const,deterministic:true,reversible:true,verification:'runtime' as const,reconciliation:'not-required' as const,inputSchemaVersion:1 as const,inputMaxBytes:4096,outputMaxBytes:4096,cancellation:'required' as const,resourceKinds:['file']}]
};
const permissions:PermissionProfile={allowedCapabilities:['file.read'],allowedRoots:[],allowExternalWrites:false,allowSystemChanges:false,allowDestructive:false};

test('third-party provider executes through canonical runtime policy without core changes',async(t)=>{
  const simulator=new AgentGatewaySimulator({manifest,provider});
  t.after(()=>simulator.close());
  const client=new TrustedAgentGatewayClient({transport:'local-sdk',principalId:'agent:external',adapterVersion:'1.0.0',clock:()=>new Date('2026-10-07T00:00:00.000Z')});
  const proposal=client.propose({id:'sim-read',capability:'file.read',risk:'read',input:{path:'/tmp/readme'},provenance:{kind:'chatgpt'}});
  const outcome=await simulator.execute(proposal,permissions);
  assert.equal(outcome.result.ok,true);
  assert.match(outcome.result.provider,/^extension:third-party\.safe-read:/);
});
