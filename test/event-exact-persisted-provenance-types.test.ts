import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableEventRuntime } from '../src/core/event-runtime.ts';

for (const field of ['eventId','eventOccurredAt','waitId','waitCreatedAt','waitNotBefore','waitDeadlineAt','waitWakeAt'] as const) {
  test('event runtime rejects array-wrapped persisted '+field, async t => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'operator-event-provenance-'));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const runtime=new DurableEventRuntime(root), id=crypto.randomUUID();
    const now=new Date().toISOString();
    await runtime.wait({waitId:id,eventType:'integrity.test',notBefore:now,deadlineAt:new Date(Date.now()+90000).toISOString(),wakeAt:new Date(Date.now()+10000).toISOString()});
    await runtime.publish({id:crypto.randomUUID(),type:'unrelated.event',payloadDigest:'a'.repeat(64),occurredAt:now});
    const file=path.join(root,'events.json'),parsed=JSON.parse(await fs.readFile(file,'utf8'));
    const map:Record<typeof field,[any,string]>={
      eventId:[parsed.events[0],'id'],eventOccurredAt:[parsed.events[0],'occurredAt'],
      waitId:[parsed.waits[0],'id'],waitCreatedAt:[parsed.waits[0],'createdAt'],
      waitNotBefore:[parsed.waits[0],'notBefore'],waitDeadlineAt:[parsed.waits[0],'deadlineAt'],waitWakeAt:[parsed.waits[0],'wakeAt']
    };
    const [target,key]=map[field];
    target[key]=[target[key]];
    const tampered=JSON.stringify(parsed);await fs.writeFile(file,tampered);
    await assert.rejects(new DurableEventRuntime(root).inspect(id),
      (e:any)=>['EVENT_INPUT_INVALID','EVENT_STATE_CORRUPT'].includes(e?.code),
      'corrupted event or wait provenance must fail closed, never look absent/valid');
    assert.equal(await fs.readFile(file,'utf8'),tampered);
  });
}
test('runtime options do not accept coercible wait bounds or retention',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'operator-event-options-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const options of [{maxWaits:'8'},{maxWaits:[8]},{terminalRetentionMs:'1000'},{terminalRetentionMs:[1000]}]){
    assert.throws(()=>new DurableEventRuntime(root,options as any),(e:any)=>e?.code==='EVENT_RUNTIME_CONFIG_INVALID');
  }
});
