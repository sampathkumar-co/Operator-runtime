import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildContextualCapabilityReadiness } from '../src/core/capability-readiness.ts';
import { discoverBuiltInCapabilities } from '../src/core/capability-discovery.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';

const permissions = {allowedCapabilities:['computer.inspect','file.*','browser.inspect'],
  allowedRoots:['/approved/proj']};
function selected(items:any){
  return items.find((entry:any)=>entry.capability==='file.read');
}
test('C02 current provider registrations never imply authenticated action execution or source-matched postconditions',async()=>{
  const declarations=await discoverBuiltInCapabilities([{
    name:'stub-files',supports:(action:any)=>action.capability==='file.read',
    score:()=>({reliability:1,latency:1,determinism:1,security:1,
      reversibility:1,informationQuality:1,interactionCost:0}),
    execute:async()=>{throw Error('probes must never execute')}
  }]);
  const result=buildContextualCapabilityReadiness({
    declaration:declarations,permissions,platform:'win32',emergencyStopped:false
  });
  assert.equal(result.authority,'NEVER_A_GRANT');
  assert.equal(result.deviceAndSessionReadiness,'NOT_VERIFIED');
  assert.equal(result.snapshotKind,'DECLARATIONS_NOT_EXECUTION');
  assert.equal(result.platform,'win32');
  assert.equal(selected(result.capabilities).state,'PROVIDER_DECLARED_NOT_EXECUTION_TESTED');
  assert.deepEqual(selected(result.capabilities).providerNames,['stub-files']);
  assert.equal(selected(result.capabilities).requiresFreshAuthorization,true);
  assert.equal(result.capabilities.find(x=>x.capability==='browser.interact')?.state,
    'SCOPE_NOT_LISTED');
  assert.equal(result.capabilities.find(x=>x.capability==='app.inspect')?.family,'WINDOWS_UIA');
});
test('C02 emergency stop, missing roots and unavailable scope suppress misleading provider readiness',async()=>{
  const snapshot=await discoverBuiltInCapabilities([{
    name:'files',supports:(action:any)=>action.capability==='file.read',
    score:()=>({reliability:1,latency:1,determinism:1,security:1,
      reversibility:1,informationQuality:1,interactionCost:0}),
    execute:async()=>{throw Error('never')}
  }]);
  const stopped=buildContextualCapabilityReadiness({
    declaration:snapshot,permissions,platform:'linux',emergencyStopped:true
  });
  assert.equal(selected(stopped.capabilities).state,'EMERGENCY_STOPPED');
  const withoutRoots=buildContextualCapabilityReadiness({
    declaration:snapshot,permissions:{...permissions,allowedRoots:[]},
    platform:'linux',emergencyStopped:false
  });
  assert.equal(selected(withoutRoots.capabilities).state,'ROOT_SCOPE_MISSING');
  const withRevocation=buildContextualCapabilityReadiness({
    declaration:snapshot,permissions:{...permissions,allowedCapabilities:[]},
    platform:'darwin',emergencyStopped:false
  });
  assert.equal(selected(withRevocation.capabilities).state,'SCOPE_NOT_LISTED');
});
test('C02 provider probe timeout/uncertainty is not advertised as known supported operation',async()=>{
  const snapshot=await discoverBuiltInCapabilities([{
    name:'uncertain-provider',supports:async()=>undefined as never,
    score:()=>({reliability:1,latency:1,determinism:1,security:1,
      reversibility:1,informationQuality:1,interactionCost:0}),
    execute:async()=>{throw Error('never')}
  }]);
  const result=buildContextualCapabilityReadiness({
    declaration:snapshot,permissions,platform:'linux',emergencyStopped:false
  });
  assert.equal(selected(result.capabilities).state,'PROVIDER_PROBE_INDETERMINATE');
  assert.deepEqual(selected(result.capabilities).providerNames,[]);
});
test('C02 malformed declarations, duplicate names or broken scope are rejected before publication',async()=>{
  const snapshot=await discoverBuiltInCapabilities([]);
  assert.throws(()=>buildContextualCapabilityReadiness({
    declaration:{...snapshot,capabilities:[snapshot.capabilities[0]!,snapshot.capabilities[0]!] },
    permissions,platform:'win32',emergencyStopped:false
  }), (error:any)=>error.code==='CAPABILITY_READINESS_INVALID');
  assert.throws(()=>buildContextualCapabilityReadiness({
    declaration:snapshot,
    permissions:{...permissions,allowedCapabilities:['file.*', 'file.*.*']},
    platform:'win32',emergencyStopped:false
  }), (error:any)=>error.code==='CAPABILITY_READINESS_INVALID');
});
test('C02 authenticated local API only publishes true current registry and request profile without target paths',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-c02-registry-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const runtime=createRuntime({allowedRoots:[root],allowedExecutables:['node']});
  const token='x'.repeat(64);
  const agent=createLocalAgentServer({
    runtime,token,permissions:{allowedCapabilities:['computer.inspect','file.*'],allowedRoots:[root]}
  });
  t.after(()=>Promise.allSettled([agent.close(),runtime.close()]));
  const bound=await agent.listen('127.0.0.1',0);
  const url='http://127.0.0.1:'+bound.port+'/v1/capabilities/readiness';
  const denied=await fetch(url);
  assert.equal(denied.status,401);
  const allowed=await fetch(url,{headers:{authorization:'Bearer '+token}});
  assert.equal(allowed.status,200);
  const response=await allowed.json() as any;
  assert.equal(response.ok,true);
  assert.equal(response.snapshot.authority,'NEVER_A_GRANT');
  assert.equal(response.snapshot.authorizedRootCount,1);
  assert.ok(response.snapshot.capabilities.length>=20);
  assert.equal(response.snapshot.capabilities.find((x:any)=>x.capability==='file.read').state,
    'PROVIDER_DECLARED_NOT_EXECUTION_TESTED');
  const json=JSON.stringify(response);
  assert.equal(json.includes(root),false,'authorized root paths must never be included');
  assert.equal(json.includes(token),false,'agent bearer token must never be disclosed');
});
