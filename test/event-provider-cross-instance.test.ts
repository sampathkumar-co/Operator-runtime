import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableEventRuntime } from '../src/core/event-runtime.ts';
import { ProviderLearningStore } from '../src/core/provider-learning.ts';

async function tempDir(t: test.TestContext) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'operator-event-learning-multi-'));
  t.after(()=>fs.rm(dir,{force:true,recursive:true}));
  return dir;
}

test('event waits across independent instances are not lost',async t=>{
  const dir=await tempDir(t);
  await Promise.all(Array.from({length:8},()=>new DurableEventRuntime(dir).wait({eventType:'task.finished'})));
  const state=JSON.parse(await fs.readFile(path.join(dir,'events.json'),'utf8'));
  assert.equal(state.waits.length,8);
});

test('independent event publishers retain every unique event',async t=>{
  const dir=await tempDir(t);
  await Promise.all(Array.from({length:8},(_,i)=>new DurableEventRuntime(dir).publish({
    id:crypto.randomUUID(),type:'task.finished',
    payloadDigest:i.toString(16).repeat(64),occurredAt:new Date().toISOString()
  })));
  const state=JSON.parse(await fs.readFile(path.join(dir,'events.json'),'utf8'));
  assert.equal(state.events.length,8);
});

test('independent provider learning updates retain distinct contexts and increments',async t=>{
  const dir=await tempDir(t);
  await Promise.all(Array.from({length:8},(_,i)=>new ProviderLearningStore(dir).record(
    'project.command.run','provider-a','verified',{context:'project-'+i,durationMs:15}
  )));
  const state=JSON.parse(await fs.readFile(path.join(dir,'provider-learning.json'),'utf8'));
  assert.equal(state.entries.length,8);
  assert.ok(state.entries.every((x:{verified:number})=>x.verified===1));
});
