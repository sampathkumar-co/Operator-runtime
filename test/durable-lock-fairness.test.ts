import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {withDurableStateLock} from '../src/core/durable-state-lock.ts';

test('legitimate same-process contention queues without losing bounded updates',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'operator-lock-fairness-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'shared-state.json');
 await fs.writeFile(file,JSON.stringify({counter:0}));
 await Promise.all(Array.from({length:16},()=>withDurableStateLock(file,async()=>{
  const state=JSON.parse(await fs.readFile(file,'utf8'));
  await new Promise(resolve=>setTimeout(resolve,250));
  state.counter+=1;
  await fs.writeFile(file,JSON.stringify(state));
 })));
 const committed=JSON.parse(await fs.readFile(file,'utf8'));
 assert.equal(committed.counter,16);
});
