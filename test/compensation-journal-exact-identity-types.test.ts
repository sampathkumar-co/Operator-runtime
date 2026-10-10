import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableCompensationJournal } from '../src/core/compensation-journal.ts';

const request = {
  id: 'recovery-intent-001', ownerKind: 'digital',
  ownerId: 'operator-123', operation: 'release-reservation',
  targetId: 'reservation-789', subjectKey: 'device-42'
};
for (const field of ['id','ownerKind','ownerId','operation','targetId','subjectKey','createdAt','confirmedAt'] as const) {
  test('compensation journal refuses coerced persisted '+field, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(),'operator-compensation-typed-'));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const journal = new DurableCompensationJournal(root);
    await journal.prepare(request);
    await journal.confirm(request.id);
    const file=path.join(root,'compensation-intents.json');
    const raw=JSON.parse(await fs.readFile(file,'utf8'));
    raw.intents[0][field] = [raw.intents[0][field]];
    const tampered=JSON.stringify(raw);
    await fs.writeFile(file,tampered);
    await assert.rejects(new DurableCompensationJournal(root).pending(),
      (e:any)=>['COMPENSATION_JOURNAL_INPUT_INVALID','COMPENSATION_JOURNAL_CORRUPT'].includes(e?.code));
    assert.equal(await fs.readFile(file,'utf8'),tampered);
  });
}
test('compensation request cannot coerce identity wrappers into real owner or reservation',async t=>{
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'operator-compensation-input-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const journal=new DurableCompensationJournal(root);
  for(const field of ['id','ownerId','targetId','subjectKey'] as const) {
    await assert.rejects(journal.prepare({...request,[field]:[request[field]]} as any),
      (e:any)=>e?.code==='COMPENSATION_JOURNAL_INPUT_INVALID');
  }
  assert.equal((await journal.pending()).length,0);
});
