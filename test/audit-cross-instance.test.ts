import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditLog, type AuditAuthenticator } from '../src/core/audit.ts';

function signer(): AuditAuthenticator {
  const secret = crypto.randomBytes(32);
  const mac = (value: Uint8Array) => crypto.createHmac('sha512', secret).update(value).digest('base64url');
  return {
    keyId: 'synthetic-audit-test-key',
    async sign(value) { return mac(value); },
    async verify(value, signature) {
      const expected = Buffer.from(mac(value));
      const actual = Buffer.from(signature);
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    }
  };
}

for (const mode of ['unsigned', 'signed'] as const) {
  test(mode + ': separate audit instances preserve the chain under concurrent appends and stale-head reuse', async (t) => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-audit-cross-'));
    t.after(() => fs.rm(state, {recursive:true,force:true}));
    const authenticator = mode === 'signed' ? signer() : undefined;
    const stores = Array.from({length:4}, () => new AuditLog(state, {authenticator}));
    const event = (i: number) => ({capability:'file.read',result:'allowed' as const,risk:'read', details:{syntheticSequence:i}});
    const initial = await stores[0]!.append(event(0));
    await stores[1]!.append(event(1));
    await stores[0]!.append(event(2)); // stale cached head must be invalidated
    const concurrent = await Promise.all(Array.from({length:12},(_,i) => stores[i % stores.length]!.append(event(3+i))));
    assert.equal(new Set([initial,...concurrent].map((item)=>item.id)).size,13);
    const fresh = new AuditLog(state, {authenticator});
    const integrity = await fresh.verifyIntegrity();
    assert.equal(integrity.valid, true);
    assert.equal(integrity.count, 15);
    const tail = await fresh.tail(20);
    assert.equal(tail.length, 15);
    assert.deepEqual(new Set(tail.map((item)=>item.details?.syntheticSequence)),new Set(Array.from({length:15},(_,i)=>i)));
    for(let i=1;i<tail.length;i++) assert.equal(tail[i]!.previousHash,tail[i-1]!.hash);
    if(mode==='signed') {
      const anchor = JSON.parse(await fs.readFile(path.join(state,'audit-freshness.json'),'utf8'));
      assert.equal(anchor.count,15);
      assert.equal(anchor.generation,15);
    }
  });
}

for (const failAt of [3,4]) {
  test('signed audit recovers an append interrupted during head-signing phase '+failAt, async (t) => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-audit-commit-recovery-'));
    t.after(() => fs.rm(state, {recursive:true,force:true}));
    const authentic = signer();
    let signed = 0;
    const unreliable: AuditAuthenticator = {
      keyId:authentic.keyId,
      async sign(payload) {
        signed += 1;
        if (signed === failAt) throw new Error('synthetic interrupted head signing');
        return authentic.sign(payload);
      },
      async verify(payload, signature) { return authentic.verify(payload, signature); }
    };
    const writer = new AuditLog(state,{authenticator:unreliable});
    const event=(i:number)=>({capability:'file.read',result:'allowed' as const,risk:'read',details:{attempt:i}});
    await writer.append(event(0));
    await assert.rejects(writer.append(event(1)),/synthetic interrupted head signing/);
    const recovered = new AuditLog(state,{authenticator:authentic});
    await recovered.append(event(2));
    const valid = await recovered.verifyIntegrity();
    assert.equal(valid.count,3);
    const events=await recovered.tail(4);
    assert.deepEqual(events.map(e=>e.details?.attempt),[0,1,2]);
    const freshness=JSON.parse(await fs.readFile(path.join(state,'audit-freshness.json'),'utf8'));
    assert.equal(freshness.count,3);
    assert.equal(freshness.generation,3);
  });
}

test('concurrent signed appenders retain one chain across bounded segment rotations', async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-audit-segment-multi-'));
  t.after(() => fs.rm(state,{recursive:true,force:true}));
  const authenticator = signer();
  const stores = Array.from({length:4},()=>new AuditLog(state,{authenticator,maxSegmentBytes:256*1024}));
  const events = Array.from({length:24},(_,i)=>({
    capability:'file.read',result:'allowed' as const,risk:'read',
    details:{sequence:i,padded1:'x'.repeat(8000),padded2:'y'.repeat(8000),padded3:'z'.repeat(8000),padded4:'w'.repeat(8000)}
  }));
  const written = await Promise.all(events.map((e,i)=>stores[i%stores.length]!.append(e)));
  assert.equal(written.length,24);
  const segments=await fs.readdir(path.join(state,'audit-segments'));
  assert.ok(segments.length >= 2,'multiple rotated audit segments must exist');
  const verify=await new AuditLog(state,{authenticator,maxSegmentBytes:256*1024}).verifyIntegrity();
  assert.equal(verify.count,24);
  const tail=await new AuditLog(state,{authenticator,maxSegmentBytes:256*1024}).tail(30);
  assert.deepEqual(new Set(tail.map(e=>e.details?.sequence)),new Set(Array.from({length:24},(_,i)=>i)));
});
