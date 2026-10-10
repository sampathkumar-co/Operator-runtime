import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateRelayAccountAuthority } from '../src/core/relay-capability-binding.ts';
import { RelayDeliveryStore } from '../src/core/relay-delivery-store.ts';
import { RelayResultStore } from '../src/core/relay-result-store.ts';

const deviceId = crypto.randomUUID();
const authority = {accountId: crypto.randomUUID(), deviceId, generation:5};

test('relay session authority does not coerce attacker/malformed generation into a valid lease', () => {
  for (const invalid of ['5',true,[5],null]) {
    assert.throws(() => validateRelayAccountAuthority({...authority,generation:invalid}),
      (err:any)=>err?.code==='RELAY_CAPABILITY_BINDING_INVALID',
      'generation must retain its native JSON integer identity');
  }
  assert.deepEqual(validateRelayAccountAuthority(authority),authority);
});

test('reloaded delivery does not accept a coerced authority generation',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-delivery-authority-integrity-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'relay-deliveries.json');
  const store=new RelayDeliveryStore(root);
  await store.enqueue(deviceId,'action',{action:{capability:'file.read'}},authority,undefined,['file.read']);
  const pristine=JSON.parse(await fs.readFile(file,'utf8'));
  for(const invalid of ['5',true,[5],null]){
    const corrupt=structuredClone(pristine);
    corrupt.streams[0].deliveries[0].authority.generation=invalid;
    await fs.writeFile(file,JSON.stringify(corrupt));
    await assert.rejects(()=>new RelayDeliveryStore(root).pending(deviceId),
      (err:any)=>err?.code==='RELAY_QUEUE_CORRUPT');
    assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),corrupt);
  }
  await fs.writeFile(file,JSON.stringify(pristine));
  assert.equal((await new RelayDeliveryStore(root).pending(deviceId)).length,1);
});

test('reloaded result replay authority rejects coerced generation',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-result-authority-integrity-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'relay-results.json');
  const store=new RelayResultStore(root);
  await store.put(deviceId,1,crypto.randomUUID(),{ok:true},'e'.repeat(64),authority);
  const pristine=JSON.parse(await fs.readFile(file,'utf8'));
  for(const invalid of ['5',true,[5],null]){
    const corrupt=structuredClone(pristine);
    corrupt.streams[0].results[0].replayAuthority.generation=invalid;
    await fs.writeFile(file,JSON.stringify(corrupt));
    await assert.rejects(()=>new RelayResultStore(root).get(deviceId,1),
      (err:any)=>err?.code==='RELAY_RESULT_AUTHORITY_INVALID');
    assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),corrupt);
  }
  await fs.writeFile(file,JSON.stringify(pristine));
  assert.equal((await new RelayResultStore(root).get(deviceId,1))?.replayAuthority?.generation,5);
});
