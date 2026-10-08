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

test('independent OS processes preserve all Teach sessions',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'operator-teach-process-'));
 t.after(()=>fs.rm(dir,{force:true,recursive:true}));
 const {execFile}=await import('node:child_process');
 const {promisify}=await import('node:util');
 const {pathToFileURL}=await import('node:url');
 const exec=promisify(execFile);
 const uri=pathToFileURL(path.resolve('src/core/studio-teach.ts')).href;
 const script=`import {TeachModeStore} from ${JSON.stringify(uri)};
await new TeachModeStore(process.argv[1]).start({
 title:'Independent process '+process.argv[2],objective:'Demo',scopeKey:'project:shared'
});`;
 await Promise.all(Array.from({length:4},(_,i)=>exec(process.execPath,[
  '--experimental-strip-types','--input-type=module','-e',script,dir,String(i)
 ],{cwd:process.cwd(),windowsHide:true,timeout:30000})));
 const state=JSON.parse(await fs.readFile(path.join(dir,'studio-teach.json'),'utf8'));
 assert.equal(state.sessions.length,4);
});
