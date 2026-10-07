import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/core/artifact-store.ts';
import { PresignedHttpsArtifactBlobBackend, type ArtifactFetch } from '../src/core/artifact-object-store.ts';

function response(status:number,bytes=Buffer.alloc(0)){
  return {ok:status>=200&&status<300,status,headers:{get:(name:string)=>name.toLowerCase()==='content-length'?String(bytes.byteLength):null},arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
}

test('presigned object backend verifies content address on upload and download',async()=>{
  const objects=new Map<string,Buffer>();
  const fetchImpl:ArtifactFetch=async(url,init)=>{
    if(init?.method==='PUT'){objects.set(url,Buffer.from(init.body??[]));return response(200);}
    return response(200,objects.get(url.replace('/get/','/put/'))??Buffer.alloc(0));
  };
  const backend=new PresignedHttpsArtifactBlobBackend({
    putUrl:({digest})=>'https://objects.example.invalid/put/'+digest+'?sig=x',
    getUrl:({digest})=>'https://objects.example.invalid/get/'+digest+'?sig=x'
  },fetchImpl);
  const bytes=Buffer.from('immutable artifact payload');
  const digest=crypto.createHash('sha256').update(bytes).digest('hex');
  await backend.put(digest,bytes);
  assert.deepEqual(await backend.get(digest),bytes);
});

test('object backend rejects insecure URLs and tampered downloads',async()=>{
  const bytes=Buffer.from('expected');
  const digest=crypto.createHash('sha256').update(bytes).digest('hex');
  const insecure=new PresignedHttpsArtifactBlobBackend({
    putUrl:()=> 'http://objects.example.invalid/blob',
    getUrl:()=> 'https://objects.example.invalid/blob'
  },async()=>response(200,bytes));
  await assert.rejects(insecure.put(digest,bytes),(e:any)=>e?.code==='ARTIFACT_OBJECT_URL_INVALID');

  const tampered=new PresignedHttpsArtifactBlobBackend({
    putUrl:()=> 'https://objects.example.invalid/blob',
    getUrl:()=> 'https://objects.example.invalid/blob'
  },async(_url,init)=>init?.method==='GET'?response(200,Buffer.from('tampered')):response(200));
  await tampered.put(digest,bytes);
  await assert.rejects(tampered.get(digest),(e:any)=>e?.code==='ARTIFACT_INTEGRITY_FAILED');
});

test('ArtifactStore can keep immutable records locally while blob bytes live in object storage',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-artifact-object-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const blobs=new Map<string,Buffer>();
  const backend={
    async put(digest:string,bytes:Uint8Array){blobs.set(digest,Buffer.from(bytes));},
    async get(digest:string){const value=blobs.get(digest);if(!value)throw new Error('missing');return Buffer.from(value);}
  };
  const store=new ArtifactStore(root,{blobBackend:backend});
  const record=await store.put({bytes:'hello object store',kind:'evidence-pack',mediaType:'application/json',privacy:'internal',now:'2026-10-07T00:00:00.000Z'});
  assert.ok(blobs.has(record.blobDigest));
  const read=await store.read(record.id);
  assert.equal(read.bytes.toString('utf8'),'hello object store');
  assert.equal(read.record.id,record.id);
});
