import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { PresignedHttpsArtifactBlobBackend, type ArtifactFetch } from '../src/core/artifact-object-store.ts';

const dig=(bytes:Uint8Array)=>crypto.createHash('sha256').update(bytes).digest('hex');
function backend(read:()=>Promise<{done:boolean;value?:Uint8Array}>,
  declared:string|null,cancel:()=>void) {
  const fetchImpl:ArtifactFetch=async()=>({
    ok:true,status:200,headers:{get:name=>name==='content-length'?declared:null},
    body:{getReader:()=>({read,async cancel(){cancel();}})},
    async arrayBuffer(){throw Error('Streaming should not use unbounded buffer');}
  });
  return new PresignedHttpsArtifactBlobBackend({
    putUrl:()=> 'https://objects.vendor.com/irrelevant',
    getUrl:()=> 'https://objects.vendor.com/blob'
  },fetchImpl);
}

test('C02 artifact reads refuse endless empty chunks rather than blocking the runtime',async()=>{
  let reads=0,cancelled=0;
  const b=backend(async()=>{reads++;return{done:false,value:new Uint8Array()};},
    null,()=>cancelled++);
  await assert.rejects(()=>b.get('a'.repeat(64)),(error:any)=>error?.code==='ARTIFACT_SIZE_INVALID');
  assert.ok(reads<=5);
  assert.equal(cancelled,1);
});

test('C02 artifact reads abort a declared-size overrun before buffering further chunks',async()=>{
  const bytes=Buffer.from('correct');
  let reads=0,cancelled=0;
  const b=backend(async()=>{
    reads++;
    return reads===1?{done:false,value:bytes}: {done:false,value:Buffer.from('more')};
  },'2',()=>cancelled++);
  await assert.rejects(()=>b.get(dig(bytes)),(error:any)=>error?.code==='ARTIFACT_SIZE_INVALID');
  assert.equal(reads,1);
  assert.equal(cancelled,1);
});

test('C02 artifact streams tolerate a few empty keepalive frames and still verify digest',async()=>{
  const payload=Buffer.from('immutable proof');
  let reads=0,cancelled=0;
  const b=backend(async()=>{
    reads++;
    if(reads<=3)return{done:false,value:new Uint8Array()};
    if(reads===4)return{done:false,value:payload};
    return{done:true};
  },String(payload.length),()=>cancelled++);
  assert.deepEqual(await b.get(dig(payload)),payload);
  assert.equal(reads,5);
  assert.equal(cancelled,0);
});

test('C02 artifact streams never accept untyped body chunks',async()=>{
  let cancelled=0;
  const b=backend(async()=>({done:false,value:'not-bytes' as unknown as Uint8Array}),
    null,()=>cancelled++);
  await assert.rejects(()=>b.get('b'.repeat(64)),(error:any)=>error?.code==='ARTIFACT_SIZE_INVALID');
  assert.equal(cancelled,1);
});
