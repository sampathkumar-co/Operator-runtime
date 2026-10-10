import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { IntentKernel } from '../src/core/intent-kernel.ts';

const conversation='synthetic-conversation-one';
const request = {objective:'Complete authorized scoped task',directive:'authorize' as const,sourceTurnId:'turn-first'};
for(const field of ['conversationId','intentVersion','directive','sourceTurnId','digest','createdAt','previousIntentDigest'] as const){
 test('intent recovery rejects type-coerced '+field,async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'operator-intent-typed-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const kernel=new IntentKernel(root,conversation);
  await kernel.update(request);
  await kernel.update({...request,sourceTurnId:'turn-second'});
  const file=path.join(root,'intent',conversation+'.json');
  const raw=JSON.parse(await fs.readFile(file,'utf8'));
  raw[field]=field==='intentVersion'?String(raw[field]):[raw[field]];
  const malformed=JSON.stringify(raw);
  await fs.writeFile(file,malformed);
  await assert.rejects(new IntentKernel(root,conversation).current(),
    (err:any)=>['INTENT_INPUT_INVALID','INTENT_STATE_CORRUPT'].includes(err?.code));
  assert.equal(await fs.readFile(file,'utf8'),malformed);
 });
}
test('intent input boundaries refuse array-wrapped conversation, directive and source turn',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'operator-intent-input-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 assert.throws(()=>new IntentKernel(root,[conversation] as any),(e:any)=>e?.code==='INTENT_INPUT_INVALID');
 const kernel=new IntentKernel(root,conversation);
 await assert.rejects(kernel.update({...request,directive:['authorize']} as any),(e:any)=>e?.code==='INTENT_INPUT_INVALID');
 await assert.rejects(kernel.update({...request,sourceTurnId:['turn-first']} as any),(e:any)=>e?.code==='INTENT_INPUT_INVALID');
 assert.equal(await kernel.current(),undefined);
});
