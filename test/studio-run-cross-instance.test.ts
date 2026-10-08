import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StudioWorkflowExecutor } from '../src/core/studio-executor.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { ResourceLeaseStore } from '../src/core/resource-leases.ts';
import type { TeachModeStore } from '../src/core/studio-teach.ts';

async function tempDir(t: test.TestContext): Promise<string> {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'operator-studio-multi-'));
  t.after(()=>fs.rm(dir,{force:true,recursive:true}));
  return dir;
}
function harness(dir:string) {
  const workflowId=crypto.randomUUID();
  const digest='a'.repeat(64);
  const teach={
    inspectWorkflow:async ()=>({id:workflowId,digest,scopeKey:'project:studio'}),
    instantiate:async ()=>[{
      key:'step-001',capability:'file.read',risk:'read',
      inputTemplate:{path:'C:/temp/proof'},resourceKeys:[],dependsOn:[]
    }]
  } as unknown as TeachModeStore;
  const runtime=new OperatorRuntime();
  const executor=()=>new StudioWorkflowExecutor(dir,{
    teach,runtime,leases:new ResourceLeaseStore(dir),
    permissions:{allowedCapabilities:['file.read'],allowedRoots:[dir]}
  });
  return {workflowId,executor,runtime};
}
test('eight independent studio run stores retain distinct durable submissions',async t=>{
  const dir=await tempDir(t);
  const {workflowId,executor,runtime}=harness(dir);
  t.after(()=>runtime.close());
  const ids=Array.from({length:8},()=>crypto.randomUUID());
  const submitted=await Promise.all(ids.map(id=>executor().submit(workflowId,{},id)));
  assert.equal(new Set(submitted.map(x=>x.id)).size,8);
  const persisted=JSON.parse(await fs.readFile(path.join(dir,'studio-runs.json'),'utf8'));
  assert.equal(persisted.runs.length,8);
});
test('studio run IDs remain immutable across independent concurrent submissions',async t=>{
  const dir=await tempDir(t);
  const {workflowId,executor,runtime}=harness(dir);
  t.after(()=>runtime.close());
  const runId=crypto.randomUUID();
  const results=await Promise.all(Array.from({length:8},()=>executor().submit(workflowId,{},runId)));
  assert.equal(new Set(results.map(x=>x.id)).size,1);
  const persisted=JSON.parse(await fs.readFile(path.join(dir,'studio-runs.json'),'utf8'));
  assert.equal(persisted.runs.length,1);
});
