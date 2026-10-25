import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import crypto from 'node:crypto';
import { ArtifactStore } from '../src/core/artifact-store.ts';
import { WindowsUiaProvider } from '../src/capabilities/windows-uia.ts';

function captureResponse(bytes:Buffer){
  return {source:'region',png_base64:bytes.toString('base64'),
    origin_x:0,origin_y:0,source_width:400,source_height:300,
    returned_width:400,returned_height:300,scale_x:1,scale_y:1};
}
const req=(id:string)=>({id,capability:'visual.capture',risk:'read',
  provenance:{kind:'runtime'},input:{source:'region',region:{x:0,y:0,width:400,height:300}}}) as any;
const digest=(bytes:Buffer)=>crypto.createHash('sha256').update(bytes).digest('hex');

test('C02/C04 large Windows screenshots become durable sensitive artifact references, not raw base64',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-visual-ref-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new ArtifactStore(root);
  const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(160000,65)]);
  const provider=new WindowsUiaProvider({platform:'win32',artifactStore:store,client:{
    async call(){return captureResponse(bytes);},close(){}
  }});
  const answer=await provider.execute(req('visual-ref'));
  assert.equal(answer.ok,true);
  const output=answer.output as any;
  assert.match(output.imageArtifactId,/^[0-9a-f]{64}$/);
  assert.equal(output.imageSha256,digest(bytes));
  assert.equal(output.imageByteLength,bytes.length);
  assert.equal(output.imagePrivacy,'sensitive');
  assert.equal(output.imageBase64,undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(answer),'utf8')<32*1024);
  const restored=await store.read(output.imageArtifactId);
  assert.deepEqual(restored.bytes,bytes);
  assert.equal(restored.record.privacy,'sensitive');
  assert.equal(restored.record.kind,'screenshot');
  assert.equal(restored.record.mediaType,'image/png');
  provider.close();
});

test('C02/C04 small native captures remain compatible with legacy inline evidence',async()=>{
  const bytes=Buffer.alloc(128,42);
  const provider=new WindowsUiaProvider({platform:'win32',client:{
    async call(){return captureResponse(bytes);},close(){}
  }});
  const outcome=await provider.execute(req('small-visual'));
  assert.equal(outcome.ok,true);
  assert.equal((outcome.output as any).imageBase64,bytes.toString('base64'));
  assert.equal((outcome.output as any).imageArtifactId,undefined);
  provider.close();
});

test('C02/C04 large capture cannot spill inline when no authorized artifact store exists',async()=>{
  const bytes=Buffer.alloc(128*1024,67);
  const provider=new WindowsUiaProvider({platform:'win32',client:{
    async call(){return captureResponse(bytes);},close(){}
  }});
  const result=await provider.execute(req('large-unbacked'));
  assert.equal(result.ok,false);
  assert.equal(result.error?.code,'VISUAL_CAPTURE_ARTIFACT_REQUIRED');
  assert.equal(result.error?.sideEffectState,'none');
  assert.equal(result.output,undefined);
  assert.ok(!JSON.stringify(result).includes(bytes.toString('base64').slice(0,100)));
  provider.close();
});
