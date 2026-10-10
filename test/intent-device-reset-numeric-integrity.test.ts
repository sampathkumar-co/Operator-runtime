import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {validIntentBinding} from '../src/core/intent-registry.ts';
import {DeviceResetStore} from '../src/core/device-reset.ts';

test('intent approval and replay binding requires exact numeric version identity', () => {
  const valid={conversationId:'conversation:1',intentVersion:7,digest:'a'.repeat(64)};
  assert.deepEqual(validIntentBinding(valid),valid);
  for(const invalid of ['7',true,[7],null]){
    assert.throws(()=>validIntentBinding({...valid,intentVersion:invalid}),
      (e:any)=>e?.code==='INTENT_BINDING_INVALID');
  }
});

test('persisted device-reset authority generation cannot be type-coerced during recovery',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'operator-reset-generation-type-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const sessionJti=crypto.randomUUID(),deviceId=crypto.randomUUID(),accountId=crypto.randomUUID();
  const store=new DeviceResetStore(dir);
  await store.begin({sessionJti,deviceId,accountId,authorityGeneration:8});
  const file=path.join(dir,'device-resets.json');
  const pristine=JSON.parse(await fs.readFile(file,'utf8'));
  for (const invalid of ['8',true,[8],null]){
    const damaged=structuredClone(pristine);
    damaged.records[0].authorityGeneration=invalid;
    await fs.writeFile(file,JSON.stringify(damaged));
    await assert.rejects(()=>new DeviceResetStore(dir).get(sessionJti),
      (e:any)=>e?.code==='DEVICE_RESET_STATE_CORRUPT');
    assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),damaged);
  }
  await fs.writeFile(file,JSON.stringify(pristine));
  assert.equal((await new DeviceResetStore(dir).get(sessionJti))?.authorityGeneration,8);
});

test('persisted workflow child indexes cannot be coerced into executable step positions',async t=>{
  const state=await fs.mkdtemp(path.join(os.tmpdir(),'operator-workflow-index-integrity-'));
  t.after(()=>fs.rm(state,{recursive:true,force:true}));
  const {TaskStore}=await import('../src/core/task-store.ts');
  const {createTask}=await import('../src/core/task.ts');
  const task=createTask({userObjective:'two-stage approved workflow',
    interpretedObjective:'two-stage approved workflow',authorizedScope:[],
    prohibitedScope:[],successConditions:['all steps must be verified']});
  const execution={
    schemaVersion:1,plannerId:'operator.semantic-workflow.v1',goalKind:'semantic-workflow',
    plannerState:{workflowIndex:1},maxSteps:10,maxAttemptsPerStep:2,timeoutMs:1000,
    stepCount:0,records:[]
  };
  const file=path.join(state,'tasks',task.id+'.json');
  await fs.mkdir(path.dirname(file),{recursive:true});
  for(const invalid of ['1',true,[1],null]){
    const poisoned={...task,execution:{...execution,plannerState:{workflowIndex:invalid}}};
    await fs.writeFile(file,JSON.stringify(poisoned));
    await assert.rejects(()=>new TaskStore(state).get(task.id),
      (e:any)=>e?.code==='TASK_STATE_CORRUPT',
      'malformed workflow step identity cannot be normalized');
  }
  await fs.writeFile(file,JSON.stringify({...task,execution}));
  assert.equal((await new TaskStore(state).get(task.id)).execution?.plannerState.workflowIndex,1);
});
