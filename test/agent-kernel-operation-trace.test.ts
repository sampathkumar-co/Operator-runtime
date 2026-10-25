import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentKernel } from '../src/core/agent-kernel.ts';
import { evaluateOperationTraceCoverage, OperationTraceStore } from '../src/core/operation-trace.ts';
import { ResourceLeaseStore } from '../src/core/resource-leases.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore, PermissionProfile } from '../src/core/types.ts';

const SCORE:CapabilityScore={
  reliability:1,latency:0,determinism:1,security:1,reversibility:1,informationQuality:1,interactionCost:0
};

class TraceProbeProvider implements CapabilityProvider {
  readonly name='trace.probe';
  supports(action:ActionRequest):boolean{return action.capability==='computer.inspect';}
  score():CapabilityScore{return SCORE;}
  resolveRisk():ActionRequest['risk']{return 'read';}
  async execute(action:ActionRequest):Promise<ActionResult>{
    return {
      ok:true,
      capability:action.capability,
      provider:this.name,
      output:{observed:true},
      evidence:[{kind:'postcondition',status:'pass',message:'Read result independently observed.',timestamp:new Date().toISOString()}],
      durationMs:1
    };
  }
}

test('AgentKernel emits complete ordered trace for a verified read action',async(t)=>{
  const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-r5-kernel-trace-'));
  t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));
  const runtime=new OperatorRuntime().register(new TraceProbeProvider());
  const trace=new OperationTraceStore(stateDir);
  const kernel=new AgentKernel({
    stateDir,
    runtime,
    leases:new ResourceLeaseStore(stateDir),
    operationTrace:trace
  });
  const action:ActionRequest={
    id:'r5-traced-read',
    capability:'computer.inspect',
    risk:'read',
    input:{path:path.join(stateDir,'probe')},
    provenance:{kind:'trusted_policy'}
  };
  const permissions:PermissionProfile={
    allowedCapabilities:['computer.inspect'],
    allowedRoots:[stateDir],
    allowExternalWrites:false,
    allowSystemChanges:false,
    allowDestructive:false
  };
  const result=await kernel.execute(action,permissions);
  assert.equal(result.ok,true);
  const events=await trace.list({traceId:action.id,limit:100});
  const stages=events.map((event)=>event.stage);
  for(const required of ['REQUEST','ROUTE','POLICY','LEASE','DISPATCH','VERIFY','COMPLETE'] as const){
    assert.ok(stages.includes(required),required);
  }
  const coverage=evaluateOperationTraceCoverage(events);
  assert.equal(coverage.complete,true);
  assert.equal(coverage.terminalOutcome,'OK');
});

test('AgentKernel keeps actions in the same task as independent causal traces',async(t)=>{
  const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-c09-kernel-action-traces-'));
  t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));
  const trace=new OperationTraceStore(stateDir);
  const kernel=new AgentKernel({
    stateDir,
    runtime:new OperatorRuntime().register(new TraceProbeProvider()),
    leases:new ResourceLeaseStore(stateDir),
    operationTrace:trace
  });
  const permissions:PermissionProfile={
    allowedCapabilities:['computer.inspect'],allowedRoots:[stateDir],
    allowExternalWrites:false,allowSystemChanges:false,allowDestructive:false
  };
  for(const id of ['c09-action-one','c09-action-two']){
    const result=await kernel.execute({
      id,taskId:'c09-shared-task',capability:'computer.inspect',risk:'read',
      input:{path:path.join(stateDir,id)},provenance:{kind:'trusted_policy'}
    },permissions);
    assert.equal(result.ok,true);
  }
  assert.equal((await trace.list({traceId:'c09-shared-task'})).length,0);
  for(const id of ['c09-action-one','c09-action-two']){
    const events=await trace.list({traceId:id,limit:100});
    assert.equal(events.filter((event)=>event.stage==='REQUEST').length,1);
    assert.equal(events.filter((event)=>event.stage==='COMPLETE').length,1);
    assert.equal(evaluateOperationTraceCoverage(events).complete,true);
  }
});
