import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeAgentGatewayProposal } from '../src/core/agent-gateway-contract.ts';
import { assertAttenuates, validatePrincipalDelegationGraph } from '../src/core/principal-delegation.ts';
import { simulateEnterprisePolicy } from '../src/core/enterprise-policy-simulation.ts';

test('agent gateway proposal binds transport proposal to exact execution identity without granting authority',()=>{
 const proposal=normalizeAgentGatewayProposal({
  schemaVersion:1,transport:'mcp',principalId:'agent:1',adapterVersion:'1.0.0',proposedAt:'2026-10-06T00:00:00.000Z',
  executionContext:{schemaVersion:1,taskId:'task-1',actionId:'action-1'},
  action:{id:'action-1',capability:'file.read',risk:'read',input:{path:'x'},provenance:{kind:'chatgpt'},taskId:'task-1'}
 });
 assert.match(proposal.digest,/^[0-9a-f]{64}$/);
});

test('agent gateway proposal rejects mismatched action lineage',()=>{
 assert.throws(()=>normalizeAgentGatewayProposal({
  schemaVersion:1,transport:'mcp',principalId:'agent:1',adapterVersion:'1.0.0',proposedAt:'2026-10-06T00:00:00.000Z',
  executionContext:{schemaVersion:1,actionId:'action-2'},
  action:{id:'action-1',capability:'file.read',risk:'read',input:{},provenance:{kind:'chatgpt'}}
 }),/actionId must match/);
});

test('delegation is attenuation-only across risk, capability, resource and lifetime',()=>{
 const parent={capabilities:['file.*','git.status'],resourcePrefixes:['project:alpha'],maxRisk:'write' as const,expiresAt:'2026-10-07T00:00:00.000Z'};
 assert.doesNotThrow(()=>assertAttenuates(parent,{capabilities:['file.read'],resourcePrefixes:['project:alpha/src'],maxRisk:'read',expiresAt:'2026-10-06T12:00:00.000Z'}));
 assert.throws(()=>assertAttenuates(parent,{capabilities:['terminal.execute'],resourcePrefixes:['project:alpha'],maxRisk:'read'}),/expands capability/);
 assert.throws(()=>assertAttenuates(parent,{capabilities:['file.read'],resourcePrefixes:['project:beta'],maxRisk:'read'}),/expands resource/);
});

test('delegation graph rejects cycles',()=>{
 assert.throws(()=>validatePrincipalDelegationGraph({
  schemaVersion:1,
  principals:[{id:'a',kind:'human',enabled:true},{id:'b',kind:'agent',enabled:true}],
  delegations:[
   {id:'d1',parentPrincipalId:'a',childPrincipalId:'b',purpose:'work',grant:{capabilities:['file.read'],resourcePrefixes:[],maxRisk:'read'},createdAt:'2026-10-06T00:00:00.000Z'},
   {id:'d2',parentPrincipalId:'b',childPrincipalId:'a',purpose:'bad',grant:{capabilities:['file.read'],resourcePrefixes:[],maxRisk:'read'},createdAt:'2026-10-06T00:00:01.000Z'}
  ]
 },{a:{capabilities:['file.*'],resourcePrefixes:[],maxRisk:'write'}}),/cycle/);
});

test('enterprise policy simulation reuses canonical policy engine without changing production state',async(t)=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-policy-sim-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const results=await simulateEnterprisePolicy({
  stateDir:dir,
  basePermissions:{allowedCapabilities:['file.*'],allowedRoots:[],maxRisk:'write'},
  roles:[{id:'developer',capabilities:['file.read'],rootPrefixes:[],maxRisk:'read',environments:['dev'],projectPrefixes:[],deviceGroups:[]}],
  bindings:[{id:'bind-1',principalId:'user:1',roleId:'developer',environment:'dev',enabled:true}],
  cases:[
   {id:'allowed',context:{principalId:'user:1',environment:'dev'}},
   {id:'denied',context:{principalId:'user:2',environment:'dev'}}
  ]
 });
 assert.deepEqual(results.map(r=>[r.id,r.allowed]),[['allowed',true],['denied',false]]);
});
