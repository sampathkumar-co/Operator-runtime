import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/core/artifact-store.ts';
import { PresignedHttpsArtifactBlobBackend } from '../src/core/artifact-object-store.ts';

const digest=(data:Uint8Array)=>crypto.createHash('sha256').update(data).digest('hex');

test('C02 artifact evidence accepts typed content addresses but never coerces attacker objects',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-c02-artifact-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new ArtifactStore(dir);
  let coerced=0;
  const hostile={toString(){coerced++;return 'a'.repeat(64);}};
  const baseline={bytes:'private evidence',kind:'screenshot' as const,
    mediaType:'image/png',privacy:'sensitive' as const,now:'2026-10-25T12:00:00.000Z'};
  const good=await store.put(baseline);
  assert.deepEqual((await store.read(good.id)).record,good);
  for(const value of [[good.id],hostile, null, true]){
    await assert.rejects(()=>store.get(value as any),(error:any)=>error?.code==='ARTIFACT_DIGEST_INVALID');
  }
  for(const changed of [
    {bytes:{valueOf:()=>Buffer.alloc(1024)}},
    {bytes:42},
    {privacy:['sensitive']},
    {privacy:hostile},
    {mediaType:['image/png']},
    {executionContextDigest:['b'.repeat(64)]},
    {now:['2026-10-25T12:00:00.000Z']}
  ]){
    await assert.rejects(()=>store.put({...baseline,...changed} as any),
      (error:any)=>typeof error?.code==='string'&&error.code.startsWith('ARTIFACT_'));
  }
  assert.equal(coerced,0,'No hostile object coercion may occur inside evidence storage');
});

test('C02 persisted artifact byte metadata cannot be type-confused while retaining a valid digest',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-c02-artifact-disk-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new ArtifactStore(dir);
  const item=await store.put({bytes:'hello',kind:'log',now:'2026-10-25T12:00:00.000Z'});
  const file=path.join(dir,'artifacts','records',item.id+'.json');
  const contents=await fs.readFile(file,'utf8');
  for(const mutation of [
    {bytes:String(item.bytes)},
    {blobDigest:[item.blobDigest]},
    {privacy:[item.privacy]},
    {mediaType:[item.mediaType]},
    {createdAt:[item.createdAt]}
  ]) {
    await fs.writeFile(file,JSON.stringify({...JSON.parse(contents),...mutation}));
    await assert.rejects(()=>store.get(item.id),(error:any)=>typeof error?.code==='string'&&error.code.startsWith('ARTIFACT_'));
  }
  await fs.writeFile(file,contents);
  assert.equal((await store.get(item.id)).id,item.id);
});

test('C02 presigned object storage URL and digest identities must never be coerced',async()=>{
  const bytes=Buffer.from('artifact content');
  const sha=digest(bytes);
  let coerced=0,networkCalls=0;
  const hostile={toString(){coerced++;return 'https://objects.example.org/artifact';}};
  const backend=new PresignedHttpsArtifactBlobBackend({
    putUrl:()=>hostile as any,getUrl:()=>hostile as any
  },async()=>{networkCalls++;return {ok:true,status:200,
    headers:{get:()=>String(bytes.byteLength)},arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};});
  await assert.rejects(()=>backend.put(sha,bytes),(error:any)=>error?.code==='ARTIFACT_OBJECT_URL_INVALID');
  await assert.rejects(()=>backend.get(sha),(error:any)=>error?.code==='ARTIFACT_OBJECT_URL_INVALID');
  await assert.rejects(()=>backend.get([sha] as any),(error:any)=>error?.code==='ARTIFACT_DIGEST_INVALID');
  await assert.rejects(()=>backend.put(sha,{length:bytes.length} as any),(error:any)=>error?.code==='ARTIFACT_SIZE_INVALID');
  assert.equal(coerced,0);
  assert.equal(networkCalls,0);
});
