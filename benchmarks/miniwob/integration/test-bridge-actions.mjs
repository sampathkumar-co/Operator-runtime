import test from 'node:test';
import assert from 'node:assert/strict';
import {providerOperationForInput,boundedScrollDelta,boundedDisplacement,relativePointForLabel,boundedRelativePoint,boundedVisiblePageText,validatedDialogPrompt} from './bridge_actions.mjs';

test('text fill uses provider type; slider retains set_value',()=>{
 assert.equal(providerOperationForInput('set_value','textbox'),'type');
 assert.equal(providerOperationForInput('set_value','searchbox'),'type');
 assert.equal(providerOperationForInput('set_value','slider'),'set_value');
 assert.equal(providerOperationForInput('type','textbox'),'type');
});
test('scroll values are bounded and sign-correct',()=>{
 assert.deepEqual(boundedScrollDelta('down'),{deltaX:0,deltaY:80});
 assert.deepEqual(boundedScrollDelta('up:320'),{deltaX:0,deltaY:-320});
 assert.throws(()=>boundedScrollDelta('down:2000'),/INVALID_SCROLL_DIRECTION/);
 assert.deepEqual(boundedScrollDelta('right:160'),{deltaX:160,deltaY:0});
 assert.throws(()=>boundedScrollDelta('diagonal:80'),/INVALID_SCROLL_DIRECTION/);
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

test('precise relative points are inside observed shape',()=>{
 assert.deepEqual(boundedRelativePoint('0.93:0.02'),{xRatio:0.93,yRatio:0.02});
 assert.deepEqual(boundedRelativePoint('1:0.00'),{xRatio:1,yRatio:0});
 assert.deepEqual(boundedRelativePoint('bottom-right'),{xRatio:0.85,yRatio:0.85});
 for(const point of ['1.01:0.5','-0.1:0.5','0.001:0.5','2:2','0.1,0.5'])
  assert.throws(()=>boundedRelativePoint(point),/INVALID_RELATIVE_POINT/);
});
test('diagonal drag stays bounded to 320 CSS pixels per axis',()=>{
 assert.deepEqual(boundedDisplacement('down-right:160'),{deltaX:160,deltaY:160});
 assert.deepEqual(boundedDisplacement('up-left:10'),{deltaX:-10,deltaY:-10});
 assert.throws(()=>boundedDisplacement('down-left:1000'),/INVALID_DISPLACEMENT/);
});


test('visible text observation reaches model without hidden DOM reads',()=>{
 const value=boundedVisiblePageText({visibleText:[{text:'Click the red circle'},{text:'Then submit'}]});
 assert.equal(value,'Click the red circle Then submit');
 assert.equal(boundedVisiblePageText({visibleText:[{text:'x'.repeat(500)}]},80).length,80);
 assert.equal(boundedVisiblePageText({visibleText:[{text:'  '},{hidden:'secret'}]}),'');
});

test('dialog prompt rejects NUL and oversized values before dispatch',()=>{
 assert.equal(validatedDialogPrompt('hello'),'hello');
 for(const value of ['x'.repeat(401),'bad\0value',null,10])
  assert.throws(()=>validatedDialogPrompt(value),/DIALOG_PROMPT_INVALID/);
});
