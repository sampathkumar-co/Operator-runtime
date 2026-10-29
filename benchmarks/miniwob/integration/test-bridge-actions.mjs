import test from 'node:test';
import assert from 'node:assert/strict';
import {providerOperationForInput,boundedScrollDelta,boundedDisplacement,relativePointForLabel} from './bridge_actions.mjs';

test('text fill uses provider type; slider retains set_value',()=>{
 assert.equal(providerOperationForInput('set_value','textbox'),'type');
 assert.equal(providerOperationForInput('set_value','searchbox'),'type');
 assert.equal(providerOperationForInput('set_value','slider'),'set_value');
 assert.equal(providerOperationForInput('type','textbox'),'type');
});
test('scroll values are bounded and sign-correct',()=>{
 assert.equal(boundedScrollDelta('down'),80);
 assert.equal(boundedScrollDelta('up:320'),-320);
 assert.throws(()=>boundedScrollDelta('down:2000'),/INVALID_SCROLL_DIRECTION/);
 assert.throws(()=>boundedScrollDelta('right'),/INVALID_SCROLL_DIRECTION/);
});
test('drag and resize movements are bounded',()=>{
 assert.deepEqual(boundedDisplacement('left:80'),{deltaX:-80,deltaY:0});
 assert.deepEqual(boundedDisplacement('down:160'),{deltaX:0,deltaY:160});
 assert.throws(()=>boundedDisplacement('down:2000'),/INVALID_DISPLACEMENT/);
 assert.throws(()=>boundedDisplacement('up:0'),/INVALID_DISPLACEMENT/);
});

test('enum-only relative points, no arbitrary coordinates',()=>{
 assert.deepEqual(relativePointForLabel('center'),{xRatio:0.5,yRatio:0.5});
 assert.deepEqual(relativePointForLabel('top-right'),{xRatio:0.85,yRatio:0.15});
 assert.throws(()=>relativePointForLabel('0.93,0.02'),/INVALID_RELATIVE_POINT/);
 assert.throws(()=>relativePointForLabel('__proto__'),/INVALID_RELATIVE_POINT/);
});
