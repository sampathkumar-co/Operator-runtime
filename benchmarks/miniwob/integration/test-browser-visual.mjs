import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedSyntheticFrameUrl,validateVisualBytes,captureSyntheticView} from './browser_visual.mjs';
test('synthetic frame authority accepts only fixture and exact declared origins',()=>{
 const prefix='file:///fixtures/miniwob/';
 assert.equal(allowedSyntheticFrameUrl('file:///fixtures/miniwob/a.html',prefix),true);
 assert.equal(allowedSyntheticFrameUrl('file:///fixtures/miniwob-evil/a.html',prefix),false);
 assert.equal(allowedSyntheticFrameUrl('https://example.org/a',prefix),false);
 assert.equal(allowedSyntheticFrameUrl('https://example.org/a',prefix,['https://example.org']),true);
 assert.equal(allowedSyntheticFrameUrl('https://example.org.evil/a',prefix,['https://example.org']),false);
});
test('bounded JPEG checks and no raw non-JPEG bytes',()=>{
 const jpeg=Buffer.from([0xff,0xd8,0,1,2,0xff,0xd9]).toString('base64');
 const result=validateVisualBytes(jpeg);
 assert.equal(result.bytes,7);
 assert.equal(result.digest.length,64);
 assert.throws(()=>validateVisualBytes(Buffer.from('not-image').toString('base64')),/SCREENSHOT_JPEG_INVALID/);
 assert.throws(()=>validateVisualBytes('a'.repeat(400000)),/SCREENSHOT_UNAVAILABLE_OR_OVERSIZE/);
});
test('CDP visual capture confirms exact fixture URL before and after',async()=>{
 const prefix='file:///fixtures/miniwob/';
 const jpeg=Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64');
 let closed=0,invoked=[];
 class FakeConnection {
  constructor(id,url){assert.equal(id,'tab');assert.match(url,/127.0.0.1/)}
  async send(method){invoked.push(method);
   return method==='Page.captureScreenshot'?{data:jpeg}:{result:{value:'file:///fixtures/miniwob/a.html'}};
  }
  close(){closed++}
 }
 const result=await captureSyntheticView(FakeConnection,{id:'tab',url:prefix+'a.html',webSocketDebuggerUrl:'ws://127.0.0.1:9330/devtools/page/tab'},prefix);
 assert.equal(result.bytes,4);
 assert.deepEqual(invoked,['Runtime.evaluate','Page.captureScreenshot','Runtime.evaluate']);
 assert.equal(closed,1);
});
