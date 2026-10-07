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
    putUrl:({digest})=>'https://objects.vendor.com/put/'+digest+'?sig=x',
    getUrl:({digest})=>'https://objects.vendor.com/get/'+digest+'?sig=x'
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
    putUrl:()=> 'http://objects.vendor.com/blob',
    getUrl:()=> 'https://objects.vendor.com/blob'
  },async()=>response(200,bytes));
  await assert.rejects(insecure.put(digest,bytes),(e:any)=>e?.code==='ARTIFACT_OBJECT_URL_INVALID');

  const tampered=new PresignedHttpsArtifactBlobBackend({
    putUrl:()=> 'https://objects.vendor.com/blob',
    getUrl:()=> 'https://objects.vendor.com/blob'
  },async(_url,init)=>init?.method==='GET'?response(200,Buffer.from('tampered')):response(200));
  await tampered.put(digest,bytes);
  await assert.rejects(tampered.get(digest),(e:any)=>e?.code==='ARTIFACT_INTEGRITY_FAILED');
});

test('object backend bounds streamed downloads before buffering and rejects non-public targets',async()=>{
  const digest='a'.repeat(64);
  let reads=0,cancelled=false,arrayBufferCalled=false;
  const chunk=new Uint8Array(1024*1024);
  const backend=new PresignedHttpsArtifactBlobBackend({
    putUrl:()=> 'https://objects.vendor.com/blob',
    getUrl:()=> 'https://objects.vendor.com/blob'
  },async()=>({
    ok:true,status:200,headers:{get:()=>null},
    body:{getReader:()=>({
      async read(){reads+=1;return reads<=65?{done:false,value:chunk}:{done:true};},
      async cancel(){cancelled=true;}
    })},
    async arrayBuffer(){arrayBufferCalled=true;return new ArrayBuffer(0);}
  }));
  await assert.rejects(backend.get(digest),(e:any)=>e?.code==='ARTIFACT_SIZE_INVALID');
  assert.equal(cancelled,true);
  assert.equal(arrayBufferCalled,false);
  assert.ok(reads<=65);

  const internal=new PresignedHttpsArtifactBlobBackend({
    putUrl:()=> 'https://169.254.169.254/blob',
    getUrl:()=> 'https://metadata.internal/blob'
  },async()=>response(200,Buffer.from('x')));
  await assert.rejects(internal.put(crypto.createHash('sha256').update('x').digest('hex'),Buffer.from('x')),(e:any)=>e?.code==='ARTIFACT_OBJECT_URL_INVALID');

  // Private object storage is allowed only through an exact, explicit HTTPS
  // origin trust decision. The presigned path/query can vary, the origin cannot.
  const privateBytes=Buffer.from('private-vpc-object');
  const privateDigest=crypto.createHash('sha256').update(privateBytes).digest('hex');
  const privateBackend=new PresignedHttpsArtifactBlobBackend({
    putUrl:()=> 'https://10.20.30.40:9443/bucket/object?sig=one',
    getUrl:()=> 'https://10.20.30.40:9443/bucket/object?sig=two'
  },async(_url,init)=>init?.method==='GET'?response(200,privateBytes):response(200),{
    targetPolicy:{mode:'approved-origins',origins:['https://10.20.30.40:9443']}
  });
  await privateBackend.put(privateDigest,privateBytes);
  assert.deepEqual(await privateBackend.get(privateDigest),privateBytes);
  const escapedOrigin=new PresignedHttpsArtifactBlobBackend({
    putUrl:()=> 'https://10.20.30.41:9443/bucket/object',
    getUrl:()=> 'https://10.20.30.41:9443/bucket/object'
  },async()=>response(200),{
    targetPolicy:{mode:'approved-origins',origins:['https://10.20.30.40:9443']}
  });
  await assert.rejects(escapedOrigin.put(privateDigest,privateBytes),(e:any)=>e?.code==='ARTIFACT_OBJECT_URL_INVALID');
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
