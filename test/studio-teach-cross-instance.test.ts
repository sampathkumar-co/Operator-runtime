import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TeachModeStore } from '../src/core/studio-teach.ts';

test('independent Teach stores persist every accepted session without lost updates',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'operator-teach-multi-'));
 t.after(()=>fs.rm(dir,{force:true,recursive:true}));
 const ids=Array.from({length:8},()=>crypto.randomUUID());
 const results=await Promise.all(ids.map((id,i)=>new TeachModeStore(dir).start({
  sessionId:id,title:'Sample session '+i,objective:'Demo',scopeKey:'project:shared'
 })));
 assert.equal(new Set(results.map(s=>s.id)).size,8);
 const state=JSON.parse(await fs.readFile(path.join(dir,'studio-teach.json'),'utf8'));
 assert.equal(state.sessions.length,8);
});
