import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeObservedGesturePath } from '../src/capabilities/browser-cdp-gesture-contract.ts';
import { BrowserCdpInspectProvider } from '../src/capabilities/browser-cdp.ts';

test('observed drag path accepts exact bounded points and preserves sequence',()=>{
 const pts=[{xRatio:0.2,yRatio:0.2},{xRatio:0.4,yRatio:0.6},{xRatio:0.7,yRatio:0.8}];
 assert.deepEqual(normalizeObservedGesturePath(pts),pts);
 assert.deepEqual(normalizeObservedGesturePath(Array.from({length:24},(_,i)=>({xRatio:0.05+i*0.01,yRatio:0.5}))).length,24);
});
test('malformed model path cannot gain native pointer execution',()=>{
 const good={xRatio:0.2,yRatio:0.4};
 const bad=[null,[],{},[good],Array(25).fill(good),[good,good],
  [good,{xRatio:1.1,yRatio:0.5}],[good,{xRatio:0.001,yRatio:0.5}],
  [good,{xRatio:'0.3',yRatio:0.5}],[good,{xRatio:NaN,yRatio:0.5}],
  [good,{xRatio:0.3,yRatio:0.5,css:'#secret'}]];
 for(const candidate of bad){assert.throws(()=>normalizeObservedGesturePath(candidate),/INVALID_BROWSER_GESTURE_PATH/)}
});
test('invalid native graphical input rejected before CDP discovery',async()=>{
 const provider=new BrowserCdpInspectProvider('http://127.0.0.1:65534');
 const cases=[
  {operation:'drag_path',target:{ref:'b-c0ff33-1-2'},path:[{xRatio:0.5,yRatio:0.5}]},
  {operation:'drag_path',target:{ref:'b-c0ff33-1-2'},path:'0.2:0.4;0.5:0.8'},
  {operation:'double_click',target:{css:'#invented'}},
  {operation:'shift_click',target:{role:'button',name:'Save'}},
  {operation:'click',target:{ref:'b-c0ff33-1-2'},path:[{xRatio:0.2,yRatio:0.3},{xRatio:0.3,yRatio:0.4}]}
 ];
 try{
  for(const input of cases){
   const result=await provider.execute({id:'invalid-gesture',capability:'browser.interact',risk:'external',
    input:{targetId:'tab1',...input},provenance:{kind:'runtime'}} as any);
   assert.equal(result.ok,false);
   assert.ok(['INVALID_BROWSER_GESTURE_PATH','INVALID_BROWSER_TARGET'].includes(result.error?.code||''),JSON.stringify(input));
  }
 }finally{provider.close()}
});
