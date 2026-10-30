import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchHeldPointerStroke, dispatchNativeClickSequence, mouseSignalForDispatch } from '../src/capabilities/browser-cdp-held-pointer.ts';

const PATH=[{x:10,y:10},{x:12,y:14},{x:18,y:18}];

test('native stroke sends one press, held movement and one release', async () => {
  const events: Array<{type:string;buttons:number;cleanup?:boolean}>=[];
  await dispatchHeldPointerStroke(PATH, async(p,cleanup)=>{
    events.push({type:String(p.type),buttons:Number(p.buttons),cleanup});
  });
  assert.deepEqual(events.map(x=>x.type),[
    'mouseMoved','mousePressed','mouseMoved','mouseMoved','mouseReleased'
  ]);
  assert.equal(events[3]!.buttons,1);
  assert.equal(events[4]!.buttons,0);
  assert.equal(events[4]!.cleanup,true);
});

test('move failure releases held mouse even after cancellation', async () => {
  const events:string[]=[];
  await assert.rejects(dispatchHeldPointerStroke(PATH,async(p,cleanup)=>{
    events.push(String(p.type)+(cleanup ? ':cleanup' : ''));
    if(p.type==='mouseMoved' && p.buttons===1)throw Error('canceled');
  }),/canceled/);
  assert.deepEqual(events,[
    'mouseMoved','mousePressed','mouseMoved','mouseReleased:cleanup'
  ]);
});

test('uncertain press response still attempts release', async () => {
  const events:string[]=[];
  await assert.rejects(dispatchHeldPointerStroke(PATH,async(p,cleanup)=>{
    events.push(String(p.type)+(cleanup ? ':cleanup' : ''));
    if(p.type==='mousePressed')throw Error('CDP_WRITE_UNCERTAIN');
  }),/CDP_WRITE_UNCERTAIN/);
  assert.deepEqual(events,[
    'mouseMoved','mousePressed','mouseReleased:cleanup'
  ]);
});

test('invalid path cannot dispatch any mouse event', async () => {
  let calls=0;
  await assert.rejects(dispatchHeldPointerStroke([PATH[0]!],async()=>{calls+=1;}),/INVALID_BROWSER_GESTURE_PATH/);
  assert.equal(calls,0);
});

test('CDP mouse cleanup does not inherit an already-aborted signal',()=>{
  const controller=new AbortController();
  controller.abort();
  assert.equal(mouseSignalForDispatch(controller.signal,false),controller.signal);
  assert.equal(mouseSignalForDispatch(controller.signal,true),undefined);
});

test('native double click releases each press and preserves clickCount',async()=>{
  const presses:number[]=[];
  const releases:number[]=[];
  await dispatchNativeClickSequence(12,18,2,0,async(params,cleanup)=>{
    if(params.type==='mousePressed')presses.push(Number(params.clickCount));
    if(params.type==='mouseReleased'){
      assert.equal(cleanup,true);
      releases.push(Number(params.clickCount));
    }
  });
  assert.deepEqual(presses,[1,2]);
  assert.deepEqual(releases,[1,2]);
});

test('native Shift click attempts release after uncertain press and never replays',async()=>{
  const events:string[]=[];
  await assert.rejects(dispatchNativeClickSequence(15,20,1,8,async(params,cleanup)=>{
    events.push(String(params.type)+(cleanup?':cleanup':''));
    if(params.type==='mousePressed')throw Error('CDP_TRANSPORT_UNCERTAIN');
  }),/CDP_TRANSPORT_UNCERTAIN/);
  assert.deepEqual(events,['mouseMoved','mousePressed','mouseReleased:cleanup']);
});

test('generic drag failure uses cleanup without replaying the stroke',async()=>{
  const points=Array.from({length:5},(_,i)=>({x:10+i,y:15+i}));
  const events:string[]=[];
  await assert.rejects(dispatchHeldPointerStroke(points,async(params,cleanup)=>{
    events.push(String(params.type)+(cleanup?':cleanup':''));
    if(params.type==='mouseMoved' && params.buttons===1)throw Error('drag aborted');
  }),/drag aborted/);
  assert.deepEqual(events,['mouseMoved','mousePressed','mouseMoved','mouseReleased:cleanup']);
});
