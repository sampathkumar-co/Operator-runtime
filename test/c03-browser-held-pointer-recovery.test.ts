import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchHeldPointerStroke } from '../src/capabilities/browser-cdp-held-pointer.ts';

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
