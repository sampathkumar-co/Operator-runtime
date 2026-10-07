import assert from 'node:assert/strict';
import test from 'node:test';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { UniversalAgentGateway } from '../src/core/universal-agent-gateway.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';
import type { ActionRequest, ActionResult, PermissionProfile } from '../src/core/types.ts';

const token='t'.repeat(32);
const permissions:PermissionProfile={allowedCapabilities:['file.read'],allowedRoots:[process.cwd()],maxRisk:'read'};
const action:ActionRequest={id:'gateway-api-action',capability:'file.read',risk:'read',input:{path:'x'},provenance:{kind:'runtime'}};

function proposal(principalId='local-user'){
  return {
    schemaVersion:1,
    transport:'local-sdk',
    principalId,
    executionContext:{schemaVersion:1,actionId:action.id},
    action,
    adapterVersion:'1.0.0',
    proposedAt:'2026-10-07T00:00:00.000Z'
  };
}

test('authenticated gateway endpoint binds to server permissions and rejects spoofed principal',async(t)=>{
  const seen:PermissionProfile[]=[];
  const gateway=new UniversalAgentGateway({
    executor:{async execute(a:ActionRequest,p:PermissionProfile):Promise<ActionResult>{seen.push(structuredClone(p));return{ok:true,capability:a.capability,provider:'gateway-test',output:{ok:true},evidence:[],durationMs:1};}},
    authorizer:{permissionsFor(){throw new Error('HTTP path must use request-derived permissions');}}
  });
  const agent=createLocalAgentServer({runtime:new OperatorRuntime(),gateway,token,permissions});
  const bound=await agent.listen('127.0.0.1',0);t.after(()=>agent.close());
  const url=`http://${bound.host}:${bound.port}/v1/gateway/execute`;

  const ok=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({...proposal(),digest:'0'.repeat(64)})});
  assert.equal(ok.status,200);
  const body:any=await ok.json();
  assert.equal(body.ok,true);
  assert.notEqual(body.receipt.proposalDigest,'0'.repeat(64));
  assert.deepEqual(seen,[permissions]);

  const spoof=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(proposal('attacker'))});
  assert.equal(spoof.status,403);
  const denied:any=await spoof.json();
  assert.equal(denied.error.code,'AGENT_GATEWAY_PRINCIPAL_MISMATCH');
});

test('gateway endpoint remains behind bearer authentication',async(t)=>{
  const gateway=new UniversalAgentGateway({
    executor:{async execute(a:ActionRequest):Promise<ActionResult>{return{ok:true,capability:a.capability,provider:'gateway-test',evidence:[],durationMs:1};}},
    authorizer:{permissionsFor(){return permissions;}}
  });
  const agent=createLocalAgentServer({runtime:new OperatorRuntime(),gateway,token,permissions});
  const bound=await agent.listen('127.0.0.1',0);t.after(()=>agent.close());
  const response=await fetch(`http://${bound.host}:${bound.port}/v1/gateway/execute`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(proposal())});
  assert.equal(response.status,401);
});
